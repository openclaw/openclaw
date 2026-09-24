import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("host-owned workspace access", () => {
  it("identifies unavailable access through wrapped errors and separate SDK instances", () => {
    const cause = new Error("host offline");
    const error = new WorkspaceAccessUnavailableError("workspace unavailable", { cause });
    expect(error.cause).toBe(cause);
    expect(isWorkspaceAccessUnavailableError(error)).toBe(true);
    expect(isWorkspaceAccessUnavailableError(new Error("wrapped", { cause: error }))).toBe(true);
    // A separately loaded SDK has a different prototype, but preserves the error code.
    expect(isWorkspaceAccessUnavailableError({ code: "WORKSPACE_ACCESS_UNAVAILABLE" })).toBe(true);
    expect(isWorkspaceAccessUnavailableError(cause)).toBe(false);
    expect(
      isWorkspaceAccessUnavailableError(new Error("Workspace access is stopped or not ready")),
    ).toBe(false);
  });
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
      const release = registerAgentWorkspaceAccess(root, {
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
      try {
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
      } finally {
        release();
      }
      expect(() => getAgentWorkspaceAccess(root, "memoryFiles")).toThrow(
        WorkspaceAccessUnavailableError,
      );
    },
  );

  it("preserves remote discovery failure causes across the SDK boundary", async () => {
    const root = workspace();
    const cause = new Error("transport disconnected");
    const release = registerAgentWorkspaceAccess(root, {
      ...provider(),
      loadSkills: async () => {
        throw cause;
      },
    });
    try {
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
      release();
      expect(() => getAgentWorkspaceAccess(root, "loadSkills")).toThrow(
        WorkspaceAccessUnavailableError,
      );
    } finally {
      release();
    }
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
    const release = registerAgentWorkspaceAccess(root, provider());
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
    const release = registerAgentWorkspaceAccess(root, host);
    const retained = getAgentWorkspaceAccess(root)!;
    expect(() => registerAgentWorkspaceAccess(root, host)).toThrow("already registered");
    release();
    await expect(
      retained.bridge.writeFile({ filePath: "AGENTS.md", data: "late" }),
    ).rejects.toThrow("stopped or not ready");
    expect(host.bridge.writeFile).not.toHaveBeenCalled();
    const releaseReplacement = registerAgentWorkspaceAccess(root, provider());
    try {
      release();
      await expect(
        getAgentWorkspaceAccess(root)!.bridge.readFile({ filePath: "AGENTS.md" }),
      ).resolves.toEqual(Buffer.from("remote"));
      await expect(retained.bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(
        "stopped or not ready",
      );
    } finally {
      releaseReplacement();
    }
  });

  it("revokes skill installation while Gateway policy is pending", async () => {
    const root = workspace();
    const policy = createDeferredCore<undefined>();
    const policyStarted = createDeferredCore();
    const mutate = vi.fn();
    const release = registerAgentWorkspaceAccess(root, {
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

  it("rejects a result returned after ownership is revoked", async () => {
    const root = workspace();
    const host = provider();
    const pending = createDeferredCore<Buffer>();
    host.bridge.readFile = vi.fn(() => pending.promise);
    const release = registerAgentWorkspaceAccess(root, host);
    const read = getAgentWorkspaceAccess(root)!.bridge.readFile({ filePath: "AGENTS.md" });
    const rejected = expect(read).rejects.toThrow(WorkspaceAccessUnavailableError);
    release();
    pending.resolve(Buffer.from("late result"));
    await rejected;
  });

  it("preserves source-aware reads and revokes retained optional capabilities", async () => {
    const root = workspace();
    const host = provider();
    host.bridge.readFileWithSource = vi.fn(async () => ({
      data: Buffer.from("remote"),
      canonicalPath: "/remote/MEMORY.md",
    }));
    host.bridge.readDirectory = vi.fn(async () => [{ name: "MEMORY.md", isDirectory: false }]);
    const release = registerAgentWorkspaceAccess(root, host);
    const retained = getAgentWorkspaceAccess(root)!;
    await expect(
      retained.bridge.readFileWithSource!({ filePath: "alias/MEMORY.md", maxBytes: 6 }),
    ).resolves.toEqual({ data: Buffer.from("remote"), canonicalPath: "/remote/MEMORY.md" });
    release();
    await expect(
      retained.bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" }),
    ).rejects.toThrow("stopped or not ready");
    await expect(retained.bridge.readDirectory!({ filePath: "." })).rejects.toThrow(
      "stopped or not ready",
    );
    expect(host.bridge.readFileWithSource).toHaveBeenCalledTimes(1);
    expect(host.bridge.readDirectory).not.toHaveBeenCalled();
  });

  it("does not return source metadata after access is revoked during a read", async () => {
    const root = workspace();
    const host = provider();
    const pending = createDeferredCore<{ data: Buffer; canonicalPath: string }>();
    host.bridge.readFileWithSource = vi.fn(() => pending.promise);
    const release = registerAgentWorkspaceAccess(root, host);
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

  it.each(["binding", "replacement", "caller", "abort"])(
    "fences local attachment preparation when %s changes during an awaited step",
    async (change) => {
      const root = workspace();
      const controller = new AbortController();
      let active = true;
      let release: (() => void) | undefined;
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
      if (change === "binding" || change === "replacement") {
        release = registerAgentWorkspaceAccess(root, provider());
        if (change === "replacement") {
          release();
          release = registerAgentWorkspaceAccess(root, provider());
        }
      } else if (change === "caller") {
        active = false;
      } else {
        controller.abort(new Error("attachment cancelled"));
      }
      try {
        await expect(pending).rejects.toThrow(
          change === "caller"
            ? "caller closed"
            : change === "abort"
              ? "attachment cancelled"
              : "Workspace access changed",
        );
      } finally {
        release?.();
      }
    },
  );

  it.each(["bridge", "ready", "stopped", "declared"])(
    "never uses local attachment preparation for a %s remote binding",
    async (state) => {
      const root = workspace();
      const prepare = vi.fn(async () => "remote note");
      const release =
        state === "declared"
          ? undefined
          : registerAgentWorkspaceAccess(root, {
              ...provider(),
              ...(state === "bridge" ? {} : { prepareTurnAttachments: prepare }),
            });
      if (state === "declared") {
        declareAgentWorkspaceAccess(root);
      } else if (state === "stopped") {
        release?.();
      }
      try {
        await expect(
          prepareAgentWorkspaceAttachments({
            workspaceDir: root,
            localExecution: { readAllowed: true, maxChars: 60_000 },
            turn,
            assertCurrent: () => {},
          }),
        ).resolves.toBeUndefined();
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        release?.();
      }
    },
  );

  it.each([false, true])("preserves bridge-only input handling after stop: %s", async (stopped) => {
    const root = workspace();
    const release = registerAgentWorkspaceAccess(root, provider());
    if (stopped) {
      release();
    }
    try {
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
    } finally {
      release();
    }
  });

  it.each(["not-ready", "stopped"])(
    "rejects attachment input for a %s workspace",
    async (state) => {
      const root = workspace();
      declareAgentWorkspaceAccess(root);
      if (state === "stopped") {
        registerAgentWorkspaceAccess(root, {
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
    const release = registerAgentWorkspaceAccess(root, {
      ...provider(),
      prepareTurnAttachments: prepare,
    });
    try {
      await prepareAgentWorkspaceAttachments({
        workspaceDir: root,
        turn: { timeoutMs: 1_000 },
        assertCurrent: () => {},
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      release();
    }
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
      const release = registerAgentWorkspaceAccess(root, host);
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
    const release = registerAgentWorkspaceAccess(root, {
      ...provider(),
      prepareTurnAttachments: prepare,
    });
    try {
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
    } finally {
      release();
    }
  });
});
