import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { startControlUiBenchGatewayServer } from "../../scripts/lib/control-ui-bench-gateway-server.ts";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.ts";
import { withTempDir } from "../../src/test-utils/temp-dir.ts";

it("holds asynchronous HTTP fixtures, retains admitted assets, and recovers from rejection", async () => {
  await withTempDir("control-ui-bench-http-", async (root) => {
    const nextRoot = path.join(root, "next");
    await mkdir(nextRoot);
    await writeFile(path.join(root, "index.html"), "<p>Original bundle</p>");
    await writeFile(path.join(nextRoot, "index.html"), "<p>Replacement bundle</p>");
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>> | undefined;
    try {
      server = await startControlUiBenchGatewayServer(root, claim.port);
      let admissions = 0;
      server.setFixtureReader(async (pathname) => {
        if (pathname === "/failure") {
          throw new Error("Synthetic fixture failure");
        }
        if (pathname === "/held" || pathname === "/index.html") {
          if (++admissions === 2) {
            entered.resolve();
          }
          await gate.promise;
        }
        return pathname === "/held"
          ? {
              body: "Released media bytes",
              contentType: "text/plain",
              headers: { "Cache-Control": "private, max-age=60" },
            }
          : undefined;
      });
      let completed = 0;
      const responses = ["/held", "/index.html"].map((pathname) =>
        fetch(`${server!.baseUrl}${pathname}`).then((response) => {
          completed += 1;
          return response;
        }),
      );
      await entered.promise;
      await server.selectBuild(nextRoot);
      expect(completed).toBe(0);
      gate.resolve();
      const [fixture, asset] = await Promise.all(responses);
      expect(fixture!.status).toBe(200);
      expect(fixture!.headers.get("cache-control")).toBe("private, max-age=60");
      expect(await fixture!.text()).toBe("Released media bytes");
      expect(await asset!.text()).toContain("Original bundle");

      const failed = await fetch(`${server.baseUrl}/failure`);
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe("Control UI benchmark request failed");
      expect(await (await fetch(`${server.baseUrl}/index.html`)).text()).toContain(
        "Replacement bundle",
      );
    } finally {
      gate.resolve();
      try {
        await server?.close();
      } finally {
        await claim.release();
      }
    }
  });
});
