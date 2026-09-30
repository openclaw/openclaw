import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const { handleControlUiHttpRequest } = await import("./control-ui.js");
const { makeMockHttpResponse } = await import("./test-http-response.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("handleControlUiHttpRequest prepared root lifecycle", () => {
  it.each([
    { kind: "bundled", file: "assets/app.js", url: "/assets/app.js", code: 200 },
    { kind: "bundled", file: "index.html", url: "/dashboard", code: 200 },
    { kind: "resolved", file: "assets/app.js", url: "/assets/app.js", code: 404 },
  ] as const)(
    "serves $file only with bundled hardlink provenance ($kind)",
    async ({ kind, file, url, code }) => {
      const root = tempDirs.make("openclaw-ui-auto-root-");
      await fs.mkdir(path.join(root, "assets"));
      const source = path.join(root, "source");
      await fs.writeFile(
        source,
        file === "index.html" ? "<html>fallback-hardlink</html>\n" : "console.log('hi');",
      );
      await fs.link(source, path.join(root, file));
      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        {
          url,
          method: "GET",
          headers: { host: "gateway.example.test" },
          headersDistinct: {},
        } as IncomingMessage,
        res,
        { root: { kind, path: root, realPath: await fs.realpath(root) } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(code);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe(
        code === 404
          ? "Not Found"
          : file === "index.html"
            ? '<html data-openclaw-control-ui-base-path="" data-openclaw-terminal-enabled="true">fallback-hardlink</html>\n'
            : "console.log('hi');",
      );
    },
  );

  it("keeps failed requests terminal without exposing build diagnostics", async () => {
    const { res, end, setHeader } = makeMockHttpResponse();
    const failedRoot = {
      kind: "failed" as const,
      message: "private-credential from /home/operator/private",
    };
    const handled = await handleControlUiHttpRequest(
      { url: "/", method: "GET" } as IncomingMessage,
      res,
      { root: failedRoot },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    expect(String(end.mock.calls[0]?.[0] ?? "")).toBe(
      "Control UI assets could not be prepared. Check the Gateway logs or run `openclaw doctor --fix`.",
    );
  });
});
