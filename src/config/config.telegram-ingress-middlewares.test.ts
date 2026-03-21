import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("telegram ingress middlewares schema", () => {
  it("accepts string and object middleware entries", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          ingressMiddlewares: [
            "file:///root/.openclaw/workspace/scripts/deterministic-public-bridge.mjs",
            {
              name: "det-bridge",
              module: "file:///root/.openclaw/workspace/scripts/deterministic-public-bridge.mjs",
              exportName: "runIngressMiddleware",
            },
          ],
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.ingressMiddlewares).toEqual([
      "file:///root/.openclaw/workspace/scripts/deterministic-public-bridge.mjs",
      {
        name: "det-bridge",
        module: "file:///root/.openclaw/workspace/scripts/deterministic-public-bridge.mjs",
        exportName: "runIngressMiddleware",
      },
    ]);
  });
});
