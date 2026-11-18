import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCurrentConfigObject,
  installConfigWriteGatewayHooks,
  requireClient,
  rpcReq,
} from "../../test/helpers/gateway/config-rpc-gateway.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";

const secret = "synthetic-config-path-secret";

describe("config write conflict diagnostics", () => {
  installConfigWriteGatewayHooks({
    configRelativePath: `${secret}/openclaw.json`,
    watchConfigFiles: false,
  });
  afterEach(resetSecretRedactionRegistryForTest);

  it.skipIf(process.platform === "win32")(
    "redacts a known secret in a refused config path",
    async () => {
      const original = await getCurrentConfigObject();
      const target = `${original.path}.target`;
      const raw = await fs.readFile(original.path, "utf8");
      registerSecretValueForRedaction(secret);
      await fs.rename(original.path, target);
      try {
        await fs.symlink(target, original.path);
        const result = await rpcReq(requireClient(), "config.patch", {
          raw: JSON.stringify({ logging: { level: "debug" } }),
          baseHash: original.hash,
        });
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("INVALID_REQUEST");
        expect(result.error?.message).toContain("is a symlink");
        expect(result.error?.message).toContain("Point OPENCLAW_CONFIG_PATH at the real file");
        expect(result.error?.message).not.toContain("re-run config.get");
        expect(result.error?.message).not.toContain(secret);
        expect(await fs.readFile(target, "utf8")).toBe(raw);
      } finally {
        await fs.rm(original.path, { force: true });
        await fs.rename(target, original.path);
      }
    },
  );
});
