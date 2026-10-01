import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

function workspace() {
  return path.resolve("test-workspace", randomUUID());
}

function provider(): AgentWorkspaceAccess {
  return {
    bridge: {
      readFile: vi.fn(async () => Buffer.from("remote")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ type: "file" as const, size: 6, mtimeMs: 1 })),
    },
  };
}

function bindWorkspace(root: string, access: AgentWorkspaceAccess) {
  const release = registerAgentWorkspaceAccess(root, access);
  onTestFinished(release);
  return release;
}

describe("host-owned workspace access", () => {
  it.each(["before", "after"])(
    "preserves Memory publication outcome when revoked %s commit",
    async (when) => {
      const root = workspace();
      const unexpected = async () => {
        throw new Error("Unexpected Memory operation");
      };
      const commitContent = vi.fn(async () => {
        release();
      });
      const release = bindWorkspace(root, {
        ...provider(),
        memoryFiles: {
          assertCurrent() {},
          listFiles: unexpected,
          inspectFile: unexpected,
          readFile: unexpected,
          readForIndexing: unexpected,
          buildMultimodalChunk: unexpected,
          watch: unexpected,
          maintenance: {
            readFile: unexpected,
            stat: unexpected,
            listDirectory: unexpected,
            mkdir: unexpected,
            rename: unexpected,
            resolveWritePath: unexpected,
            commitContent,
            resolveDreamsPath: unexpected,
            readDreams: unexpected,
            writeDreams: unexpected,
            replaceReport: unexpected,
            appendCorpus: unexpected,
          },
        },
      });
      const retained = getAgentWorkspaceAccess(root)!.memoryFiles!.maintenance!;
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
      expect(() => getAgentWorkspaceAccess(root, "memoryFiles")).toThrow(
        WorkspaceAccessUnavailableError,
      );
    },
  );

  it("preserves remote discovery failure causes across the SDK boundary", async () => {
    const root = workspace();
    const cause = new Error("transport disconnected");
    const release = bindWorkspace(root, {
      ...provider(),
      loadSkills: async () => {
        throw cause;
      },
    });
    // The provider fails before using its request; the binding still owns classification.
    const loadSkills = getAgentWorkspaceAccess(root)!.loadSkills!;
    await loadSkills({
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
    }).then(
      () => {
        throw new Error("expected discovery to fail");
      },
      (error: unknown) => {
        expect(error).toMatchObject({ cause });
        expect(isWorkspaceAccessUnavailableError(error)).toBe(true);
        expect(isWorkspaceAccessUnavailableError(new Error("wrapped", { cause: error }))).toBe(
          true,
        );
        // Plugins may load a separate copy of the SDK; identity cannot depend on prototypes.
        expect(isWorkspaceAccessUnavailableError({ code: "WORKSPACE_ACCESS_UNAVAILABLE" })).toBe(
          true,
        );
      },
    );
    expect(isWorkspaceAccessUnavailableError(cause)).toBe(false);
    expect(
      isWorkspaceAccessUnavailableError(new Error("Workspace access is stopped or not ready")),
    ).toBe(false);
    release();
    expect(() => getAgentWorkspaceAccess(root, "loadSkills")).toThrow(
      WorkspaceAccessUnavailableError,
    );
  });

  it("leaves unconfigured workspaces local and declared workspaces unavailable until start", () => {
    const root = workspace();
    expect(getAgentWorkspaceAccess(root)).toBeUndefined();
    declareAgentWorkspaceAccess(root);
    expect(() => getAgentWorkspaceAccess(root)).toThrow(WorkspaceAccessUnavailableError);
    expect(() => getAgentWorkspaceAccess(root, "memoryFiles")).toThrow(
      WorkspaceAccessUnavailableError,
    );
    expect(() => getAgentWorkspaceAccess(root, "loadSkills")).toThrow(
      WorkspaceAccessUnavailableError,
    );
    const release = bindWorkspace(root, provider());
    expect(getAgentWorkspaceAccess(root)).toBeDefined();
    expect(getAgentWorkspaceAccess(root, "memoryFiles")).toBeUndefined();
    expect(getAgentWorkspaceAccess(root, "loadSkills")).toBeUndefined();
    release();
    expect(() => getAgentWorkspaceAccess(root)).toThrow(WorkspaceAccessUnavailableError);
    expect(getAgentWorkspaceAccess(root, "memoryFiles")).toBeUndefined();
    expect(getAgentWorkspaceAccess(root, "loadSkills")).toBeUndefined();
  });

  it("rejects duplicate ownership and revokes retained methods without affecting a replacement", async () => {
    const root = workspace();
    const host = provider();
    const release = bindWorkspace(root, host);
    const retained = getAgentWorkspaceAccess(root)!;
    expect(() => bindWorkspace(root, host)).toThrow("already registered");
    release();
    await expect(
      retained.bridge.writeFile({ filePath: "AGENTS.md", data: "late" }),
    ).rejects.toThrow("stopped or not ready");
    expect(host.bridge.writeFile).not.toHaveBeenCalled();
    bindWorkspace(root, provider());
    release();
    await expect(
      getAgentWorkspaceAccess(root)!.bridge.readFile({ filePath: "AGENTS.md" }),
    ).resolves.toEqual(Buffer.from("remote"));
    await expect(retained.bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(
      "stopped or not ready",
    );
  });

  it("revokes skill installation while Gateway policy is pending", async () => {
    const root = workspace();
    const policy = createDeferredCore<undefined>();
    const policyStarted = createDeferredCore();
    const mutate = vi.fn();
    const release = bindWorkspace(root, {
      ...provider(),
      applySkillRoot: async (params) => {
        await params.beforeInstall?.("install");
        mutate();
        return { ok: true, targetDir: "/host/skills/test", mode: "install" };
      },
    });
    const retained = getAgentWorkspaceAccess(root)!.applySkillRoot!;
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
    const rejected = expect(install).rejects.toThrow("stopped or not ready");
    await policyStarted.promise;
    release();
    policy.resolve(undefined);
    await rejected;
    expect(mutate).not.toHaveBeenCalled();
    await expect(
      retained({ workspaceDir: root, extractedRoot: "/source", slug: "test", mode: "install" }),
    ).rejects.toThrow("stopped or not ready");
  });

  it("preserves source-aware reads and revokes retained optional capabilities", async () => {
    const root = workspace();
    const host = provider();
    host.bridge.readFileWithSource = vi.fn(async () => ({
      data: Buffer.from("remote"),
      canonicalPath: "/remote/MEMORY.md",
    }));
    host.bridge.readDirectory = vi.fn(async () => [{ name: "MEMORY.md", isDirectory: false }]);
    host.bridge.createFileExclusive = vi.fn(async () => "created" as const);
    const release = bindWorkspace(root, host);
    const retained = getAgentWorkspaceAccess(root)!;
    await expect(
      retained.bridge.readFileWithSource!({ filePath: "alias/MEMORY.md", maxBytes: 6 }),
    ).resolves.toEqual({ data: Buffer.from("remote"), canonicalPath: "/remote/MEMORY.md" });
    await expect(
      retained.bridge.createFileExclusive!({ filePath: "MEMORY.md", data: "new memory" }),
    ).resolves.toBe("created");
    release();
    await expect(
      retained.bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" }),
    ).rejects.toThrow("stopped or not ready");
    await expect(retained.bridge.readDirectory!({ filePath: "." })).rejects.toThrow(
      "stopped or not ready",
    );
    await expect(
      retained.bridge.createFileExclusive!({ filePath: "MEMORY.md", data: "late memory" }),
    ).rejects.toThrow("stopped or not ready");
    expect(host.bridge.readFileWithSource).toHaveBeenCalledTimes(1);
    expect(host.bridge.readDirectory).not.toHaveBeenCalled();
    expect(host.bridge.createFileExclusive).toHaveBeenCalledTimes(1);
  });

  it("does not report exclusive creation success after its host is revoked", async () => {
    const root = workspace();
    const host = provider();
    host.bridge.createFileExclusive = vi.fn(async () => {
      release();
      return "created" as const;
    });
    const release = bindWorkspace(root, host);
    await expect(
      getAgentWorkspaceAccess(root)!.bridge.createFileExclusive!({
        filePath: "MEMORY.md",
        data: "new memory",
      }),
    ).rejects.toThrow(WorkspaceAccessUnavailableError);
    expect(host.bridge.createFileExclusive).toHaveBeenCalledTimes(1);
  });

  it("does not return source metadata after access is revoked during a read", async () => {
    const root = workspace();
    const host = provider();
    const pending = createDeferredCore<{ data: Buffer; canonicalPath: string }>();
    host.bridge.readFileWithSource = vi.fn(() => pending.promise);
    const release = bindWorkspace(root, host);
    const read = getAgentWorkspaceAccess(root)!.bridge.readFileWithSource!({
      filePath: "AGENTS.md",
    });
    const rejected = expect(read).rejects.toThrow(WorkspaceAccessUnavailableError);
    release();
    pending.resolve({ data: Buffer.from("late result"), canonicalPath: "/remote/AGENTS.md" });
    await rejected;
  });
});

describe("workspace attachment preparation", () => {
  const turn = { timeoutMs: 1_000, media: [{ path: "media://inbound/report.pdf" }] };
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "finishes short attachment reads before publishing paths (close failure: %s)",
    async (closeFailure) => {
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
      const { prepareLocalWorkspaceAttachments } = await import("./workspace-attachments.local.js");

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
      expect(handles).toHaveLength(1);
      expect(handles[0]!.fd).toBe(-1);
    },
  );

  it.each(["binding", "caller", "abort"])(
    "fences local attachment preparation when %s changes during an awaited step",
    async (change) => {
      const root = workspace();
      const controller = new AbortController();
      let active = true;
      const pending = prepareAgentWorkspaceAttachments({
        workspaceDir: root,
        localExecution: { readAllowed: true, maxChars: 60_000 },
        turn: { ...turn, abortSignal: controller.signal },
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller closed");
          }
        },
      });
      if (change === "binding") {
        bindWorkspace(root, provider());
      } else if (change === "caller") {
        active = false;
      } else {
        controller.abort(new Error("attachment cancelled"));
      }
      await expect(pending).rejects.toThrow(
        change === "caller"
          ? "caller closed"
          : change === "abort"
            ? "attachment cancelled"
            : "Workspace access changed",
      );
    },
  );

  it.each(["ready", "bridge", "stopped", "declared"])(
    "never uses local attachment preparation for a %s remote binding",
    async (state) => {
      const root = workspace();
      const prepare = vi.fn(async () => "remote note");
      const release =
        state === "declared"
          ? undefined
          : bindWorkspace(root, {
              ...provider(),
              ...(state === "bridge" ? {} : { prepareTurnAttachments: prepare }),
            });
      if (state === "declared") {
        declareAgentWorkspaceAccess(root);
      } else if (state === "stopped") {
        release?.();
      }
      await expect(
        prepareAgentWorkspaceAttachments({
          workspaceDir: root,
          localExecution: { readAllowed: true, maxChars: 60_000 },
          turn,
          assertCurrent: () => {},
        }),
      ).resolves.toBeUndefined();
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("preserves bridge-only input handling after stop", async () => {
    const root = workspace();
    const release = bindWorkspace(root, provider());
    release();
    for (const media of [undefined, [], [{ kind: "image" as const }]]) {
      await expect(
        prepareAgentWorkspaceAttachments({
          workspaceDir: root,
          turn: { timeoutMs: 1_000, media },
          assertCurrent: () => {},
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: root,
        turn,
        assertCurrent: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { input: "declared", host: "absent" },
    { input: "deferred", host: "absent" },
    { input: "declared", host: "bridge-only" },
    { input: "declared", host: "empty-note" },
    { input: "declared", host: "blank-note" },
  ])("rejects required $input attachments with provider state $host", async ({ input, host }) => {
    const root = workspace();
    if (host !== "absent") {
      bindWorkspace(root, {
        ...provider(),
        ...(host === "empty-note" || host === "blank-note"
          ? { prepareTurnAttachments: async () => (host === "blank-note" ? " \n\t" : undefined) }
          : {}),
      });
    }
    const attachmentTurn =
      input === "deferred"
        ? {
            timeoutMs: turn.timeoutMs,
            userTurnTranscriptRecorder: createDeferredRecorder({
              text: "Read the attachment",
              media: turn.media,
            }),
          }
        : turn;
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: root,
        turn: attachmentTurn,
        assertCurrent: () => {},
        requirePreparation: true,
      }),
    ).rejects.toThrow(
      host === "empty-note" || host === "blank-note"
        ? "Workspace attachment 1 could not be prepared; ensure every attachment is available to the registered attachment provider before retrying"
        : "Workspace attachments require a registered attachment provider; configure one for this execution environment before retrying",
    );
  });

  it.each([false, true])(
    "preserves deferred attachment notes with required preparation %s",
    async (requirePreparation) => {
      const root = workspace();
      bindWorkspace(root, {
        ...provider(),
        prepareTurnAttachments: async ({ media }) =>
          media
            ?.map((fact) => `[media attached: /executor/${path.basename(fact.path!)}]`)
            .join("\n"),
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
        prepareAgentWorkspaceAttachments({
          workspaceDir: root,
          turn: { ...turn, userTurnTranscriptRecorder: recorder },
          assertCurrent: () => {},
          requirePreparation,
        }),
      ).resolves.toBe(
        requirePreparation
          ? "[media attached: /executor/one.txt]\n[media attached: /executor/two.txt]"
          : "[media attached: /executor/one.txt]\n[media attached: /executor/one.txt]\n[media attached: /executor/two.txt]",
      );
    },
  );

  it("allows a text-only recorder when attachment preparation is required without a provider", async () => {
    const recorder = createDeferredRecorder({ text: "Text-only request" });
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: workspace(),
        turn: { timeoutMs: turn.timeoutMs, userTurnTranscriptRecorder: recorder },
        assertCurrent: () => {},
        requirePreparation: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a replacement workspace while resolving required attachment facts", async () => {
    const root = workspace();
    const host = { ...provider(), prepareTurnAttachments: async () => "prepared path" };
    const release = bindWorkspace(root, host);
    const recorder = createDeferredRecorder({ text: "Read the attachment", media: turn.media });
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: root,
        turn: {
          timeoutMs: turn.timeoutMs,
          userTurnTranscriptRecorder: {
            ...recorder,
            async resolveMessage() {
              release();
              bindWorkspace(root, host);
              return await recorder.resolveMessage();
            },
          },
        },
        assertCurrent: () => {},
        requirePreparation: true,
      }),
    ).rejects.toThrow("Workspace access changed during attachment preparation");
  });

  it.each(["not-ready", "stopped"])(
    "rejects attachment input for a %s workspace",
    async (state) => {
      const root = workspace();
      declareAgentWorkspaceAccess(root);
      if (state === "stopped") {
        bindWorkspace(root, {
          ...provider(),
          prepareTurnAttachments: vi.fn(async () => undefined),
        })();
      }
      await expect(
        prepareAgentWorkspaceAttachments({ workspaceDir: root, turn, assertCurrent: () => {} }),
      ).rejects.toThrow("stopped or not ready");
    },
  );

  it("does not call an attachment provider for plain text", async () => {
    const root = workspace();
    const prepare = vi.fn(async () => "unused");
    bindWorkspace(root, {
      ...provider(),
      prepareTurnAttachments: prepare,
    });
    await prepareAgentWorkspaceAttachments({
      workspaceDir: root,
      turn: { timeoutMs: 1_000 },
      assertCurrent: () => {},
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])(
    "fences attachment preparation revoked %s dispatch",
    async (when) => {
      const root = workspace();
      const host = provider();
      let assertUploadCurrent!: () => void;
      host.prepareTurnAttachments = vi.fn<
        NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>
      >(async (_turn, assertCurrent) => {
        assertUploadCurrent = assertCurrent;
        release();
        expect(assertCurrent).toThrow("stopped or not ready");
        return "obsolete note";
      });
      const release = bindWorkspace(root, host);
      const retained = getAgentWorkspaceAccess(root)!.prepareTurnAttachments!;
      if (when === "before") {
        release();
      }
      await expect(retained(turn, () => {})).rejects.toThrow("stopped or not ready");
      expect(host.prepareTurnAttachments).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      if (when === "during") {
        expect(assertUploadCurrent).toThrow("stopped or not ready");
      }
    },
  );

  it.each(["caller", "abort"])("fences %s closure during attachment transfer", async (closure) => {
    const root = workspace();
    const controller = new AbortController();
    let active = true;
    const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(
      async (_turn, assertCurrent) => {
        if (closure === "caller") {
          active = false;
        } else {
          controller.abort(new Error("aborted attachment"));
        }
        expect(assertCurrent).toThrow();
        return "obsolete note";
      },
    );
    bindWorkspace(root, {
      ...provider(),
      prepareTurnAttachments: prepare,
    });
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: root,
        turn: { ...turn, abortSignal: controller.signal },
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller closed");
          }
        },
      }),
    ).rejects.toThrow(closure === "caller" ? "caller closed" : "aborted attachment");
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
