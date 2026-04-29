import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  evaluateFileTransferDispatchPolicy,
  isFileTransferCommand,
} from "./file-transfer-dispatch.js";

function cfgWith(
  fileTransfer: Record<
    string,
    {
      ask?: "off" | "on-miss" | "always";
      allowReadPaths?: string[];
      allowWritePaths?: string[];
      denyPaths?: string[];
      followSymlinks?: boolean;
    }
  > | null,
): OpenClawConfig {
  if (fileTransfer === null) {
    return {} as OpenClawConfig;
  }
  return { gateway: { nodes: { fileTransfer } } } as OpenClawConfig;
}

describe("isFileTransferCommand", () => {
  it("matches the four file-transfer commands and nothing else", () => {
    expect(isFileTransferCommand("file.fetch")).toBe(true);
    expect(isFileTransferCommand("dir.list")).toBe(true);
    expect(isFileTransferCommand("dir.fetch")).toBe(true);
    expect(isFileTransferCommand("file.write")).toBe(true);
    expect(isFileTransferCommand("camera.snap")).toBe(false);
    expect(isFileTransferCommand("system.run")).toBe(false);
    expect(isFileTransferCommand("file.write.prepare")).toBe(false);
  });
});

describe("evaluateFileTransferDispatchPolicy — short-circuits", () => {
  it("returns ok for non-file-transfer commands without consulting policy", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith(null),
      command: "camera.snap",
      params: {},
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects INVALID_PATH for missing path", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: {},
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
  });

  it("rejects INVALID_PATH for relative path", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "relative/file" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
  });

  it("rejects INVALID_PATH for NUL byte", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "/tmp/foo\0bar" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "INVALID_PATH" });
  });

  it("rejects '..' traversal before glob match", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/allowed/**"] } }),
      command: "file.fetch",
      params: { path: "/allowed/../etc/passwd" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
    expect(r.ok ? "" : r.reason).toMatch(/\.\./);
  });

  it("rejects backslash '..' traversal (Windows mixed separators)", () => {
    // POSIX path.isAbsolute rejects "C:\\..." before the '..' scan runs,
    // so this lands as INVALID_PATH on a POSIX gateway. Either rejection
    // is acceptable — the request never reaches the node.
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["C:/allowed/**"] } }),
      command: "file.fetch",
      params: { path: "C:\\allowed\\..\\Windows\\system.ini" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toMatch(/INVALID_PATH|POSIX|POLICY_DENIED/);
  });

  it("rejects '..' on a posix-style allowed path (defense-in-depth before glob)", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/allowed/**"] } }),
      command: "file.fetch",
      // Hybrid POSIX path with backslash component — should still trip
      // the '..' check via the unified-separator scan.
      params: { path: "/allowed\\..\\etc\\passwd" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
  });
});

describe("evaluateFileTransferDispatchPolicy — NO_POLICY default deny", () => {
  it("denies when no fileTransfer config is present", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith(null),
      command: "file.fetch",
      params: { path: "/tmp/x" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "NO_POLICY" });
  });

  it("denies when fileTransfer block exists but has no entry for this node", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ "other-node": { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "/tmp/x" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "NO_POLICY" });
  });

  it("falls back to '*' wildcard when neither id nor displayName matches", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ "*": { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "/tmp/x" },
      nodeId: "n1",
      nodeDisplayName: "anything",
      homedir: undefined,
    });
    expect(r).toEqual({ ok: true });
  });
});

describe("evaluateFileTransferDispatchPolicy — denyPaths always wins", () => {
  it("denies when denyPaths matches even with allowPaths match", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({
        n1: { allowReadPaths: ["/tmp/**"], denyPaths: ["**/.ssh/**"] },
      }),
      command: "file.fetch",
      params: { path: "/tmp/.ssh/id_rsa" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
    expect(r.ok ? "" : r.reason).toMatch(/deny/);
  });
});

describe("evaluateFileTransferDispatchPolicy — allow matching", () => {
  it("allows file.fetch when path matches allowReadPaths", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "/tmp/foo/bar.png" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toEqual({ ok: true });
  });

  it("allows file.write only against allowWritePaths, not allowReadPaths", () => {
    const cfg = cfgWith({
      n1: { allowReadPaths: ["/tmp/**"], allowWritePaths: ["/srv/**"] },
    });
    expect(
      evaluateFileTransferDispatchPolicy({
        cfg,
        command: "file.write",
        params: { path: "/srv/out.txt" },
        nodeId: "n1",
        nodeDisplayName: undefined,
        homedir: undefined,
      }),
    ).toEqual({ ok: true });
    // /tmp matches read-only, not write — must deny.
    expect(
      evaluateFileTransferDispatchPolicy({
        cfg,
        command: "file.write",
        params: { path: "/tmp/out.txt" },
        nodeId: "n1",
        nodeDisplayName: undefined,
        homedir: undefined,
      }),
    ).toMatchObject({ ok: false, code: "POLICY_DENIED" });
  });

  it("expands ~ relative to provided homedir", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["~/Downloads/**"] } }),
      command: "file.fetch",
      params: { path: "/Users/o/Downloads/photo.png" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: "/Users/o",
    });
    expect(r).toEqual({ ok: true });
  });

  it("denies when no allowPaths configured for the kind", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { allowReadPaths: ["/tmp/**"] } }),
      command: "file.write",
      params: { path: "/tmp/x" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
    expect(r.ok ? "" : r.reason).toMatch(/no allowWritePaths/);
  });

  it("denies when allowPaths configured but no match (raw bypass blocked)", () => {
    // The dedicated tool would have prompted (ask=on-miss) and persisted
    // before reaching here. Anyone calling node.invoke directly without
    // a persisted match gets denied at the gateway.
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ n1: { ask: "on-miss", allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "/etc/passwd" },
      nodeId: "n1",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED" });
  });
});

describe("evaluateFileTransferDispatchPolicy — node identity resolution", () => {
  it("resolves by displayName when nodeId entry is missing", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({ "Lobster MacBook": { allowReadPaths: ["/tmp/**"] } }),
      command: "file.fetch",
      params: { path: "/tmp/x" },
      nodeId: "node-abc-123",
      nodeDisplayName: "Lobster MacBook",
      homedir: undefined,
    });
    expect(r).toEqual({ ok: true });
  });

  it("doesn't accidentally hit Object.prototype.constructor", () => {
    const r = evaluateFileTransferDispatchPolicy({
      cfg: cfgWith({}),
      command: "file.fetch",
      params: { path: "/tmp/x" },
      nodeId: "constructor",
      nodeDisplayName: undefined,
      homedir: undefined,
    });
    expect(r).toMatchObject({ ok: false, code: "NO_POLICY" });
  });
});
