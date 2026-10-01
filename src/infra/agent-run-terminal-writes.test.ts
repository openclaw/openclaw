import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetAgentEventsForTest } from "./agent-events.js";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  getAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import {
  bindAgentRunTerminalWrites,
  captureAgentRunTerminalWriteContext,
  clearAgentRunTerminalWriteContext,
  drainAgentRunTerminalWrites,
} from "./agent-run-terminal-writes.js";

const instance = { instanceId: "terminal-instance", runId: "terminal-run" };

function capture() {
  const captured = captureAgentRunTerminalWriteContext(instance.runId);
  if (!captured) {
    throw new Error("Expected the bound terminal write owner");
  }
  return captured;
}

beforeEach(() => resetAgentEventsForTest());
afterEach(() => resetAgentEventsForTest());

describe("admitted terminal writes", () => {
  it("keeps context-free normal completion open until accepted persistence settles", async () => {
    const root = claimAgentRunDelegatedAuthority(instance);
    bindAgentRunTerminalWrites(root);
    const captured = capture();
    const release = createDeferred();
    const write = vi.fn();
    const pending = release.promise.then(() => captured.run(write));
    captured.track(pending);
    let completed = false;
    const finish = drainAgentRunTerminalWrites(instance).finally(() => {
      releaseAgentRunDelegatedAuthority(root);
      completed = true;
    });
    try {
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
      expect(write).not.toHaveBeenCalled();
      release.resolve();
      await finish;
      expect(write).toHaveBeenCalledOnce();
      expect(completed).toBe(true);
      expect(validateAgentRunDelegatedAuthority(root)).toBe(false);
    } finally {
      release.resolve();
      await finish;
    }
  });

  it("preserves the CLI writer on owner-only rebinding and never repeats an undefined write", () => {
    const root = claimAgentRunDelegatedAuthority(instance);
    const contexts: string[] = [];
    const context = {
      run: <T>(write: () => T): T => {
        contexts.push("account-a");
        return write();
      },
    };
    bindAgentRunTerminalWrites(root, context);
    const captured = capture();
    bindAgentRunTerminalWrites(root);
    const write = vi.fn(() => undefined);

    expect(captured.run(write)).toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
    expect(contexts).toEqual(["account-a"]);
  });

  it.each(["context-free", "same-context", "already-cleared"] as const)(
    "never revives a %s capture after fallback, and retains its pending promise",
    async (initial) => {
      const root = claimAgentRunDelegatedAuthority(instance);
      const accountA = { run: <T>(write: () => T): T => write() };
      const accountB = { run: <T>(write: () => T): T => write() };
      bindAgentRunTerminalWrites(root, initial === "same-context" ? accountA : undefined);
      const stale = capture();
      const release = createDeferred();
      const write = vi.fn();
      const pending = release.promise.then(() => stale.run(write));
      stale.track(pending);
      const rejected = expect(pending).rejects.toThrow("Terminal write owner changed");

      if (initial === "same-context") {
        bindAgentRunTerminalWrites(root, accountB);
        bindAgentRunTerminalWrites(root, accountA);
      } else {
        if (initial === "context-free") {
          bindAgentRunTerminalWrites(root, accountA);
        }
        clearAgentRunTerminalWriteContext(instance);
      }
      bindAgentRunTerminalWrites(root);
      const fresh = capture();
      expect(() => stale.assertCurrent()).toThrow("Terminal write owner changed");
      expect(() => fresh.assertCurrent()).not.toThrow();
      let drained = false;
      const draining = drainAgentRunTerminalWrites(instance).then(() => {
        drained = true;
      });
      try {
        await Promise.resolve();
        expect(drained).toBe(false);
        release.resolve();
        await rejected;
        await draining;
        expect(write).not.toHaveBeenCalled();
        expect(fresh.run(() => "current")).toBe("current");
      } finally {
        release.resolve();
        await Promise.allSettled([pending, draining]);
      }
    },
  );

  it.each(["abort", "replacement"] as const)(
    "revokes immediately on %s while an accepted write remains queued",
    async (reason) => {
      const root = claimAgentRunDelegatedAuthority(instance);
      bindAgentRunTerminalWrites(root);
      const captured = capture();
      const release = createDeferred();
      const write = vi.fn();
      const pending = release.promise.then(() => captured.run(write));
      captured.track(pending);
      const rejected = expect(pending).rejects.toThrow("Terminal write owner changed");
      let drained = false;
      const draining = drainAgentRunTerminalWrites(instance).then(() => {
        drained = true;
      });
      const successor =
        reason === "replacement"
          ? claimAgentRunDelegatedAuthority({ ...instance, instanceId: "next-terminal-instance" })
          : undefined;
      if (reason === "abort") {
        releaseAgentRunDelegatedAuthority(root);
      }
      try {
        expect(validateAgentRunDelegatedAuthority(root)).toBe(false);
        await Promise.resolve();
        expect(drained).toBe(false);
        release.resolve();
        await rejected;
        await draining;
        expect(write).not.toHaveBeenCalled();
        if (successor) {
          expect(validateAgentRunDelegatedAuthority(successor)).toBe(true);
          expect(getAgentRunContext(instance.runId)?.delegatedAuthority).toBe(successor);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([pending, draining]);
      }
    },
  );

  it.each(["copy", "subordinate", "closed", "clear-requested"] as const)(
    "does not bind a %s authority",
    (kind) => {
      const root = claimAgentRunDelegatedAuthority(instance);
      const candidate =
        kind === "copy"
          ? { ...root }
          : kind === "subordinate"
            ? claimAgentRunApprovalAuthority(root, [new AbortController().signal])
            : root;
      if (kind === "closed") {
        releaseAgentRunDelegatedAuthority(root);
      } else if (kind === "clear-requested") {
        clearAgentRunContext(instance.runId, root.lifecycleGeneration);
        expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
      }
      expect(() => bindAgentRunTerminalWrites(candidate)).toThrow();
      expect(captureAgentRunTerminalWriteContext(instance.runId)).toBeUndefined();
    },
  );

  it.each(["bind", "capture", "commit"] as const)(
    "rereads the exact owner after source callbacks during %s",
    (boundary) => {
      let duringCheck: (() => void) | undefined;
      const root = claimAgentRunDelegatedAuthority(instance, () => {
        const callback = duringCheck;
        duringCheck = undefined;
        callback?.();
      });
      if (boundary !== "bind") {
        bindAgentRunTerminalWrites(root);
      }
      const captured = boundary === "commit" ? capture() : undefined;
      let successor: typeof root | undefined;
      duringCheck = () => {
        successor = claimAgentRunDelegatedAuthority({
          ...instance,
          instanceId: "reentrant-terminal-instance",
        });
      };
      const write = vi.fn();
      if (boundary === "bind") {
        expect(() => bindAgentRunTerminalWrites(root)).toThrow();
      } else if (boundary === "capture") {
        expect(captureAgentRunTerminalWriteContext(instance.runId)).toBeUndefined();
      } else {
        expect(() => captured?.run(write)).toThrow();
      }
      expect(write).not.toHaveBeenCalled();
      expect(successor).toBeDefined();
      expect(getAgentRunContext(instance.runId)?.delegatedAuthority).toBe(successor);
    },
  );

  it("does not manufacture a terminal owner from an otherwise live run", () => {
    claimAgentRunDelegatedAuthority(instance);
    expect(captureAgentRunTerminalWriteContext(instance.runId)).toBeUndefined();
  });
});
