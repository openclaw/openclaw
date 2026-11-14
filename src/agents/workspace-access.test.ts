import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.message.js";
import type {
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  declareAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
  isWorkspaceAccessUnavailableError,
  WorkspaceAccessUnavailableError,
  registerAgentWorkspaceAccess,
  prepareAgentWorkspaceAttachments,
  type AgentWorkspaceAccess,
} from "./workspace-access.js";
import { prepareLocalWorkspaceAttachments } from "./workspace-attachments.local.js";
import { createWorkspaceMemoryFileClient } from "./workspace-memory-client.js";

let root: string;
beforeEach(() => {
  root = path.resolve("test-workspace", randomUUID());
});
const stopped = "stopped or not ready";
const turn = { timeoutMs: 1_000, media: [{ path: "media://inbound/report.pdf" }] };
const localExecution = { readAllowed: true, maxChars: 60_000 };
const prepareAttachments = (
  overrides: Partial<Parameters<typeof prepareAgentWorkspaceAttachments>[0]> = {},
) =>
  prepareAgentWorkspaceAttachments({ workspaceDir: root, turn, assertCurrent() {}, ...overrides });
const expectStopped = (result: Promise<unknown>) => expect(result).rejects.toThrow(stopped);
const workspace = () => getAgentWorkspaceAccess(root)!;
const expectUnavailable = (capability?: Parameters<typeof getAgentWorkspaceAccess>[1]) =>
  expect(() => getAgentWorkspaceAccess(root, capability)).toThrow(WorkspaceAccessUnavailableError);

function callerLifetime() {
  const controller = new AbortController();
  let active = true;
  return {
    turn: { ...turn, abortSignal: controller.signal },
    assertCurrent() {
      if (!active) {
        throw new Error("caller closed");
      }
    },
    close(change: string, abortError: string) {
      if (change === "caller") {
        active = false;
      } else {
        controller.abort(new Error(abortError));
      }
    },
  };
}

const deferredTurn = (recorder: UserTurnTranscriptRecorder) => ({
  timeoutMs: turn.timeoutMs,
  userTurnTranscriptRecorder: recorder,
});

function provider(overrides: Partial<AgentWorkspaceAccess> = {}): AgentWorkspaceAccess {
  return {
    bridge: {
      readFile: vi.fn(async () => Buffer.from("remote")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ type: "file" as const, size: 6, mtimeMs: 1 })),
    },
    ...overrides,
  };
}

function bindWorkspace(access: Partial<AgentWorkspaceAccess> = {}) {
  const release = registerAgentWorkspaceAccess(root, provider(access));
  onTestFinished(release);
  return release;
}

describe("host-owned workspace access", () => {
  it.each(["before", "after"])("preserves publication when revoked %s commit", async (when) => {
    const unexpected = async () => {
      throw new Error("Unexpected Memory operation");
    };
    const commitContent = vi.fn(async () => {
      release();
    });
    const files = createWorkspaceMemoryFileClient({
      workspaceDir: root,
      remoteWorkspaceDir: "/memory",
      signal: new AbortController().signal,
      request: unexpected,
      subscribe: unexpected,
    });
    const release = bindWorkspace({
      memoryFiles: {
        ...files,
        maintenance: { ...files.maintenance!, commitContent },
      },
    });
    const retained = workspace().memoryFiles!.maintenance!;
    if (when === "before") {
      release();
    }
    await expect(
      retained.commitContent({
        filePath: path.join(root, "MEMORY.md"),
        tempPrefix: "memory",
        content: "new",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_ACCESS_UNAVAILABLE",
      ...(when === "after" ? { publication: "committed" } : {}),
    });
    expect(commitContent).toHaveBeenCalledTimes(when === "after" ? 1 : 0);
    expectUnavailable("memoryFiles");
  });

  it("preserves remote discovery failure causes across the SDK boundary", async () => {
    const cause = new Error("transport disconnected");
    const release = bindWorkspace({
      loadSkills: async () => {
        throw cause;
      },
    });
    const loadSkills = workspace().loadSkills!;
    const pending = loadSkills({
      sourcePlan: {
        workspaceDir: root,
        roots: [],
        pluginSkillsDir: root,
        pluginSkillRoots: [],
        managedSkillsDir: root,
        stateDir: root,
      },
      limits: { maxCandidatesPerRoot: 1, maxSkillsLoadedPerSource: 1, maxSkillFileBytes: 1 },
      additionalBins: [],
    });
    await expect(pending).rejects.toMatchObject({ cause });
    const error = await pending.catch((failure: unknown) => failure);
    expect(
      [
        error,
        new Error("wrapped", { cause: error }),
        { code: "WORKSPACE_ACCESS_UNAVAILABLE" },
        cause,
        new Error("Workspace access is stopped or not ready"),
      ].map(isWorkspaceAccessUnavailableError),
    ).toEqual([true, true, true, false, false]);
    release();
    expectUnavailable("loadSkills");
  });

  it("leaves unconfigured workspaces local and declared workspaces unavailable until start", async () => {
    expect(getAgentWorkspaceAccess(root)).toBeUndefined();
    declareAgentWorkspaceAccess(root);
    for (const capability of [undefined, "memoryFiles", "loadSkills"] as const) {
      expectUnavailable(capability);
    }
    await expectStopped(prepareAttachments());
    const release = bindWorkspace();
    expect(getAgentWorkspaceAccess(root)).toBeDefined();
    expect(getAgentWorkspaceAccess(root, "memoryFiles")).toBeUndefined();
    expect(getAgentWorkspaceAccess(root, "loadSkills")).toBeUndefined();
    release();
    expectUnavailable();
    expect(getAgentWorkspaceAccess(root, "memoryFiles")).toBeUndefined();
    expect(getAgentWorkspaceAccess(root, "loadSkills")).toBeUndefined();
    await expect(prepareAttachments()).resolves.toBeUndefined();
  });

  it("rejects duplicate ownership and revokes retained methods without affecting a replacement", async () => {
    const host = provider();
    const release = bindWorkspace(host);
    const retained = workspace();
    expect(() => bindWorkspace(host)).toThrow("already registered");
    release();
    await expectStopped(retained.bridge.writeFile({ filePath: "AGENTS.md", data: "late" }));
    expect(host.bridge.writeFile).not.toHaveBeenCalled();
    bindWorkspace();
    release();
    await expect(workspace().bridge.readFile({ filePath: "AGENTS.md" })).resolves.toEqual(
      Buffer.from("remote"),
    );
    await expectStopped(retained.bridge.readFile({ filePath: "AGENTS.md" }));
  });

  it("revokes skill installation while Gateway policy is pending", async () => {
    const policy = createDeferredCore<undefined>();
    const policyStarted = createDeferredCore();
    const mutate = vi.fn();
    const release = bindWorkspace({
      applySkillRoot: async (params) => {
        await params.beforeInstall?.("install");
        mutate();
        return { ok: true, targetDir: "/host/skills/test", mode: "install" };
      },
    });
    const retained = workspace().applySkillRoot!;
    const install = retained({
      workspaceDir: root,
      extractedRoot: "/source",
      slug: "test",
      mode: "install",
      beforeInstall: async () => {
        policyStarted.resolve();
        return policy.promise;
      },
    });
    const rejected = expectStopped(install);
    await policyStarted.promise;
    release();
    policy.resolve(undefined);
    await rejected;
    expect(mutate).not.toHaveBeenCalled();
    await expectStopped(
      retained({ workspaceDir: root, extractedRoot: "/source", slug: "test", mode: "install" }),
    );
  });

  it("preserves source-aware reads and revokes retained optional capabilities", async () => {
    const host = provider();
    const source = { data: Buffer.from("remote"), canonicalPath: "/remote/MEMORY.md" };
    const read = { filePath: "alias/MEMORY.md", maxBytes: 6 };
    const create = { filePath: "MEMORY.md", data: "new memory" };
    host.bridge.readFileWithSource = vi.fn(async () => source);
    host.bridge.readDirectory = vi.fn(async () => [{ name: "MEMORY.md", isDirectory: false }]);
    host.bridge.createFileExclusive = vi.fn(async () => "created" as const);
    const release = bindWorkspace(host);
    const bridge = workspace().bridge;
    await expect(bridge.readFileWithSource!(read)).resolves.toEqual({
      data: Buffer.from("remote"),
      canonicalPath: "/remote/MEMORY.md",
    });
    await expect(bridge.createFileExclusive!(create)).resolves.toBe("created");
    release();
    await expectStopped(bridge.readFileWithSource!(read));
    await expectStopped(bridge.readDirectory!({ filePath: "." }));
    await expectStopped(bridge.createFileExclusive!({ ...create, data: "late memory" }));
    expect(host.bridge.readFileWithSource).toHaveBeenCalledTimes(1);
    expect(host.bridge.readDirectory).not.toHaveBeenCalled();
    expect(host.bridge.createFileExclusive).toHaveBeenCalledTimes(1);
  });

  it("rejects a pending bridge result after its owner stops", async () => {
    const host = provider();
    const pending = createDeferredCore();
    host.bridge.createFileExclusive = vi.fn(async () => {
      await pending.promise;
      return "created" as const;
    });
    const release = bindWorkspace(host);
    const result = workspace().bridge.createFileExclusive!({ filePath: "MEMORY.md", data: "new" });
    const rejected = expect(result).rejects.toThrow(WorkspaceAccessUnavailableError);
    release();
    pending.resolve();
    await rejected;
    expect(host.bridge.createFileExclusive).toHaveBeenCalledOnce();
  });
});

describe("workspace attachment preparation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])("finishes short reads (close failure: %s)", async (closeFailure) => {
    const stateDir = tempDirs.make("openclaw-attachment-prefix-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const mediaDir = path.join(stateDir, "media");
    await fs.mkdir(mediaDir);
    const filePath = path.join(mediaDir, "attachment");
    await fs.writeFile(filePath, "%PDF-1.7\nsynthetic attachment\n%%EOF\n");
    const handles: FileHandle[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === filePath) {
        handles.push(handle);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          const result = await read(...readArgs);
          return { ...result, bytesRead: Math.min(1, result.bytesRead) };
        });
        if (closeFailure) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            throw new Error("attachment close failed");
          });
        }
      }
      return handle;
    });

    const note = await prepareLocalWorkspaceAttachments({
      media: [{ path: filePath }],
      execution: {
        readAllowed: true,
        maxChars: 10_000,
        config: {
          gateway: {
            http: { endpoints: { responses: { files: { allowedMimes: ["application/pdf"] } } } },
          },
        },
      },
      assertCurrent() {},
    });

    if (closeFailure) {
      expect(note).toBeUndefined();
    } else {
      expect(note).toContain(JSON.stringify(filePath));
    }
    expect(handles.map(({ fd }) => fd)).toEqual([-1]);
  });

  it.each(["binding", "caller", "abort"])("fences local %s changes", async (change) => {
    const caller = callerLifetime();
    const pending = prepareAttachments({ localExecution, ...caller });
    if (change === "binding") {
      bindWorkspace();
    } else {
      caller.close(change, "attachment cancelled");
    }
    await expect(pending).rejects.toThrow(
      change === "caller"
        ? "caller closed"
        : change === "abort"
          ? "attachment cancelled"
          : "Workspace access changed",
    );
  });

  it("does not substitute local preparation for a registered remote owner", async () => {
    const prepare = vi.fn(async () => "remote note");
    bindWorkspace({ prepareTurnAttachments: prepare });
    await expect(prepareAttachments({ localExecution })).resolves.toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["absent", "blank-note"])("rejects required files with %s host", async (host) => {
    if (host === "blank-note") {
      bindWorkspace({ prepareTurnAttachments: async () => " \n\t" });
    }
    await expect(prepareAttachments({ requirePreparation: true })).rejects.toThrow(
      host === "blank-note"
        ? "Workspace attachment 1 could not be prepared; check that every attachment is available to the registered attachment provider before retrying"
        : "Workspace attachments require a registered attachment provider; configure one for this execution environment before retrying",
    );
  });

  it.each([false, true])("preserves deferred notes (required: %s)", async (requirePreparation) => {
    bindWorkspace({
      prepareTurnAttachments: async ({ media }) =>
        media?.map((fact) => `[media attached: /executor/${path.basename(fact.path!)}]`).join("\n"),
    });
    const recorder = createDeferredRecorder({
      text: "Read both attachments",
      media: [
        { path: "media://inbound/one.txt" },
        { path: "media://inbound/one.txt" },
        { path: "media://inbound/two.txt" },
      ],
    });

    await expect(
      prepareAttachments({
        turn: { ...turn, ...deferredTurn(recorder) },
        requirePreparation,
      }),
    ).resolves.toBe(
      requirePreparation
        ? "[media attached: /executor/one.txt]\n[media attached: /executor/two.txt]"
        : "[media attached: /executor/one.txt]\n[media attached: /executor/one.txt]\n[media attached: /executor/two.txt]",
    );
  });

  it.each(["direct", "deferred"])("accepts %s text without a provider", async (input) => {
    const prepare = vi.fn(async () => "unused");
    if (input === "direct") {
      bindWorkspace({ prepareTurnAttachments: prepare });
    }
    await expect(
      prepareAttachments({
        turn:
          input === "deferred"
            ? deferredTurn(createDeferredRecorder({ text: "Text-only request" }))
            : { timeoutMs: turn.timeoutMs },
        requirePreparation: input === "deferred",
      }),
    ).resolves.toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a replacement workspace while resolving required attachment facts", async () => {
    const host = provider({ prepareTurnAttachments: async () => "prepared path" });
    const release = bindWorkspace(host);
    const recorder = createDeferredRecorder({ text: "Read the attachment", media: turn.media });
    await expect(
      prepareAttachments({
        turn: deferredTurn({
          ...recorder,
          async resolveMessage() {
            release();
            bindWorkspace(host);
            return await recorder.resolveMessage();
          },
        }),
        requirePreparation: true,
      }),
    ).rejects.toThrow("Workspace access changed during attachment preparation");
  });

  it.each([
    { closure: "binding", when: "before", error: stopped },
    { closure: "binding", when: "during", error: stopped },
    { closure: "caller", when: "during", error: "caller closed" },
    { closure: "abort", when: "during", error: "aborted attachment" },
  ])("fences $closure closure $when attachment dispatch", async ({ closure, when, error }) => {
    const caller = callerLifetime();
    let assertUploadCurrent!: () => void;
    const host = provider();
    host.prepareTurnAttachments = vi.fn<
      NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>
    >(async (_turn, assertCurrent) => {
      assertUploadCurrent = assertCurrent;
      if (closure === "binding") {
        release();
      } else {
        caller.close(closure, error);
      }
      expect(assertCurrent).toThrow(error);
      return "obsolete note";
    });
    const release = bindWorkspace(host);
    const retained = workspace().prepareTurnAttachments!;
    if (when === "before") {
      release();
    }
    const preparation =
      closure === "binding" ? retained(turn, () => {}) : prepareAttachments(caller);
    await expect(preparation).rejects.toThrow(error);
    expect(host.prepareTurnAttachments).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    if (when === "during") {
      expect(assertUploadCurrent).toThrow(error);
    }
  });
});

function createDeferredRecorder(input: UserTurnInput): UserTurnTranscriptRecorder {
  const unexpectedLifecycle = (): never => {
    throw new Error("Attachment preparation must not invoke transcript lifecycle operations");
  };
  return {
    message: undefined,
    resolveMessage: async () => buildPersistedUserTurnMessage({ ...input, timestamp: 1 }),
    getAdmissionReceipt: unexpectedLifecycle,
    markRuntimePersistencePending: unexpectedLifecycle,
    markRuntimePersisted: unexpectedLifecycle,
    markBlocked: unexpectedLifecycle,
    hasPersisted: unexpectedLifecycle,
    isBlocked: unexpectedLifecycle,
    hasRuntimePersistencePending: unexpectedLifecycle,
    waitForRuntimePersistence: unexpectedLifecycle,
    persistApproved: unexpectedLifecycle,
    persistBlocked: unexpectedLifecycle,
    persistFallback: unexpectedLifecycle,
  };
}
