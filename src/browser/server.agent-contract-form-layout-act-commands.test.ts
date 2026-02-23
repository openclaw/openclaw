import path from "node:path";
import { fetch as realFetch } from "undici";
import { describe, expect, it } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  getBrowserControlServerTestState,
  getPwMocks,
  setBrowserControlServerEvaluateEnabled,
} from "./server.control-server.test-harness.js";

const state = getBrowserControlServerTestState();
const pwMocks = getPwMocks();

describe("browser control server", () => {
  installAgentContractHooks();

  const slowTimeoutMs = process.platform === "win32" ? 40_000 : 20_000;

  it(
    "agent contract: form + layout act commands",
    async () => {
      const base = await startServerAndBase();

      const select = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "select",
        ref: "5",
        values: ["a", "b"],
      });
      expect(select.ok).toBe(true);
      expect(pwMocks.selectOptionViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        ref: "5",
        values: ["a", "b"],
      });

      const fill = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "fill",
        fields: [{ ref: "6", type: "textbox", value: "hello" }],
      });
      expect(fill.ok).toBe(true);
      expect(pwMocks.fillFormViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        fields: [{ ref: "6", type: "textbox", value: "hello" }],
      });

      const resize = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "resize",
        width: 800,
        height: 600,
      });
      expect(resize.ok).toBe(true);
      expect(pwMocks.resizeViewportViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        width: 800,
        height: 600,
      });

      const wait = await postJson<{ ok: boolean }>(`${base}/act`, {
        kind: "wait",
        timeMs: 5,
      });
      expect(wait.ok).toBe(true);
      expect(pwMocks.waitForViaPlaywright).toHaveBeenCalledWith({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        timeMs: 5,
        text: undefined,
        textGone: undefined,
      });

      const evalRes = await postJson<{ ok: boolean; result?: string }>(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      });
      expect(evalRes.ok).toBe(true);
      expect(evalRes.result).toBe("ok");
      expect(pwMocks.evaluateViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: state.cdpBaseUrl,
          targetId: "abcd1234",
          fn: "() => 1",
          ref: undefined,
          signal: expect.any(AbortSignal),
        }),
      );
    },
    slowTimeoutMs,
  );

  it(
    "blocks act:evaluate when browser.evaluateEnabled=false",
    async () => {
      setBrowserControlServerEvaluateEnabled(false);
      const base = await startServerAndBase();

      const waitRes = await postJson<{ error?: string }>(`${base}/act`, {
        kind: "wait",
        fn: "() => window.ready === true",
      });
      expect(waitRes.error).toContain("browser.evaluateEnabled=false");
      expect(pwMocks.waitForViaPlaywright).not.toHaveBeenCalled();

      const res = await postJson<{ error?: string }>(`${base}/act`, {
        kind: "evaluate",
        fn: "() => 1",
      });

      expect(res.error).toContain("browser.evaluateEnabled=false");
      expect(pwMocks.evaluateViaPlaywright).not.toHaveBeenCalled();
    },
    slowTimeoutMs,
  );

  it("agent contract: hooks + response + downloads + screenshot", async () => {
    const base = await startServerAndBase();

    const upload = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["a.txt"],
      timeoutMs: 1234,
    });
    expect(upload).toMatchObject({ ok: true });
    expect(pwMocks.armFileUploadViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      // The server resolves paths (which adds a drive letter on Windows for `\\tmp\\...` style roots).
      paths: [path.resolve(DEFAULT_UPLOAD_DIR, "a.txt")],
      timeoutMs: 1234,
    });

    const uploadWithRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["b.txt"],
      ref: "e12",
    });
    expect(uploadWithRef).toMatchObject({ ok: true });

    const uploadWithInputRef = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["c.txt"],
      inputRef: "e99",
    });
    expect(uploadWithInputRef).toMatchObject({ ok: true });

    const uploadWithElement = await postJson(`${base}/hooks/file-chooser`, {
      paths: ["d.txt"],
      element: "input[type=file]",
    });
    expect(uploadWithElement).toMatchObject({ ok: true });

    const dialog = await postJson(`${base}/hooks/dialog`, {
      accept: true,
      timeoutMs: 5678,
    });
    expect(dialog).toMatchObject({ ok: true });

    const waitDownload = await postJson(`${base}/wait/download`, {
      path: "report.pdf",
      timeoutMs: 1111,
    });
    expect(waitDownload).toMatchObject({ ok: true });

    const download = await postJson(`${base}/download`, {
      ref: "e12",
      path: "report.pdf",
    });
    expect(download).toMatchObject({ ok: true });

    const responseBody = await postJson(`${base}/response/body`, {
      url: "**/api/data",
      timeoutMs: 2222,
      maxChars: 10,
    });
    expect(responseBody).toMatchObject({ ok: true });

    const consoleRes = (await realFetch(`${base}/console?level=error`).then((r) => r.json())) as {
      ok: boolean;
      messages?: unknown[];
    };
    expect(consoleRes.ok).toBe(true);
    expect(Array.isArray(consoleRes.messages)).toBe(true);

    const pdf = await postJson<{ ok: boolean; path?: string }>(`${base}/pdf`, {});
    expect(pdf.ok).toBe(true);
    expect(typeof pdf.path).toBe("string");

    const shot = await postJson<{ ok: boolean; path?: string }>(`${base}/screenshot`, {
      element: "body",
      type: "jpeg",
    });
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");
  });

  it("blocks file chooser traversal / absolute paths outside uploads dir", async () => {
    const base = await startServerAndBase();

    const traversal = await postJson<{ error?: string }>(`${base}/hooks/file-chooser`, {
      paths: ["../../../../etc/passwd"],
    });
    expect(traversal.error).toContain("Invalid path");
    expect(pwMocks.armFileUploadViaPlaywright).not.toHaveBeenCalled();

    const absOutside = path.join(path.parse(DEFAULT_UPLOAD_DIR).root, "etc", "passwd");
    const abs = await postJson<{ error?: string }>(`${base}/hooks/file-chooser`, {
      paths: [absOutside],
    });
    expect(abs.error).toContain("Invalid path");
    expect(pwMocks.armFileUploadViaPlaywright).not.toHaveBeenCalled();
  });

  it("agent contract: stop endpoint", async () => {
    const base = await startServerAndBase();

    const stopped = (await realFetch(`${base}/stop`, {
      method: "POST",
    }).then((r) => r.json())) as { ok: boolean; stopped?: boolean };
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
  });

  it("trace stop rejects traversal path outside trace dir", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ error?: string }>(`${base}/trace/stop`, {
      path: "../../pwned.zip",
    });
    expect(res.error).toContain("Invalid path");
    expect(pwMocks.traceStopViaPlaywright).not.toHaveBeenCalled();
  });

  it("trace stop accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; path?: string }>(`${base}/trace/stop`, {
      path: "safe-trace.zip",
    });
    expect(res.ok).toBe(true);
    expect(res.path).toContain("safe-trace.zip");
    expect(pwMocks.traceStopViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        path: expect.stringContaining("safe-trace.zip"),
      }),
    );
  });

  it("wait/download rejects traversal path outside downloads dir", async () => {
    const base = await startServerAndBase();
    const waitRes = await postJson<{ error?: string }>(`${base}/wait/download`, {
      path: "../../pwned.pdf",
    });
    expect(waitRes.error).toContain("Invalid path");
    expect(pwMocks.waitForDownloadViaPlaywright).not.toHaveBeenCalled();
  });

  it("download rejects traversal path outside downloads dir", async () => {
    const base = await startServerAndBase();
    const downloadRes = await postJson<{ error?: string }>(`${base}/download`, {
      ref: "e12",
      path: "../../pwned.pdf",
    });
    expect(downloadRes.error).toContain("Invalid path");
    expect(pwMocks.downloadViaPlaywright).not.toHaveBeenCalled();
  });

  it("wait/download accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; download?: { path?: string } }>(
      `${base}/wait/download`,
      {
        path: "safe-wait.pdf",
      },
    );
    expect(res.ok).toBe(true);
    expect(pwMocks.waitForDownloadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        path: expect.stringContaining("safe-wait.pdf"),
      }),
    );
  });

  it("download accepts in-root relative output path", async () => {
    const base = await startServerAndBase();
    const res = await postJson<{ ok?: boolean; download?: { path?: string } }>(`${base}/download`, {
      ref: "e12",
      path: "safe-download.pdf",
    });
    expect(res.ok).toBe(true);
    expect(pwMocks.downloadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        ref: "e12",
        path: expect.stringContaining("safe-download.pdf"),
      }),
    );
  });
});
