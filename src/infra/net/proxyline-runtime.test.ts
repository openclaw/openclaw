import { expect, it } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";

it("keeps optional proxy helpers cold until an agent is requested", () => {
  const captureUrl = new URL("../../proxy-capture/env.ts", import.meta.url).href;
  const sdkUrl = new URL("../../plugin-sdk/extension-shared.ts", import.meta.url).href;
  const output = execNodeEvalSync(
    `
      import assert from "node:assert/strict";
      import { Agent } from "node:http";
      import { registerHooks } from "node:module";

      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
        delete process.env[key];
        delete process.env[key.toLowerCase()];
      }
      let resolutions = 0;
      const hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@openclaw/proxyline") {
            resolutions++;
          }
          return nextResolve(specifier, context);
        },
      });
      let agent;
      try {
        const capture = await import(${JSON.stringify(captureUrl)});
        const sdk = await import(${JSON.stringify(sdkUrl)});
        const deferred = sdk.createDeferred();
        deferred.resolve("ready");
        assert.equal(await deferred.promise, "ready");
        assert.equal(capture.createDebugProxyWebSocketAgent({ enabled: false, proxyUrl: "http://proxy.example.test" }), undefined);
        assert.equal(capture.createDebugProxyWebSocketAgent({ enabled: true }), undefined);
        assert.equal(resolutions, 0, "unrelated helpers must not load the proxy runtime");

        assert.equal(await sdk.resolveAmbientNodeProxyAgent(), undefined);
        assert.ok(resolutions > 0, "agent selection uses the real proxy runtime");
        agent = capture.createDebugProxyWebSocketAgent({ enabled: true, proxyUrl: "http://proxy.example.test" });
        assert.ok(agent instanceof Agent);
        console.log("ok");
      } finally {
        agent?.destroy();
        hook.deregister();
      }
    `,
    { imports: ["tsx"] },
  );
  expect(output.trim()).toBe("ok");
});
