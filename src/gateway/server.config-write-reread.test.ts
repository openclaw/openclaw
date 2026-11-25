import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getCurrentConfigObject,
  installSharedConfigWriteGatewayHooks,
  requireClient,
  rpcReq,
  writeJsonFile,
} from "../../test/helpers/gateway/config-rpc-gateway.js";
import { getRuntimeConfig } from "../config/io.runtime.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";

describe("gateway config canonical rereads", () => {
  installSharedConfigWriteGatewayHooks({
    watchConfigFiles: false,
    fixturePaths: ["logging.json"],
  });

  it.each(["config.set", "config.patch"] as const)(
    "%s settles when an external edit invalidates the canonical reread",
    async (method) => {
      const configFactory = await import("../config/io.factory.js");
      const original = await getCurrentConfigObject();
      await writeJsonFile(path.join(path.dirname(original.path), "logging.json"), {
        level: "info",
      });
      await writeJsonFile(original.path, {
        ...original.config,
        logging: { $include: "logging.json" },
        gateway: { reload: { mode: method === "config.set" ? "off" : "hybrid" } },
      });
      invalidateConfigGetResponseCache();
      const draft = await getCurrentConfigObject();
      let committed: Awaited<ReturnType<typeof getCurrentConfigObject>> | undefined;
      const createIO = configFactory.createConfigIO;
      vi.spyOn(configFactory, "createConfigIO").mockImplementation((options) => {
        const io = createIO(options);
        return {
          ...io,
          writeConfigFile: async (...args) => {
            const written = await io.writeConfigFile(...args);
            if (io.configPath === original.path) {
              invalidateConfigGetResponseCache();
              committed = await getCurrentConfigObject();
              await fs.writeFile(original.path, "{ external editor incomplete\n");
            }
            return written;
          },
        };
      });
      const result = await rpcReq(requireClient(), method, {
        raw: JSON.stringify({
          ...(method === "config.set" ? draft.config : {}),
          ui: { prefs: { locale: "fr" } },
        }),
        baseHash: draft.hash,
      });
      expect(result.ok, result.error?.message).toBe(method === "config.set");
      expect(committed?.config).toMatchObject({ logging: { level: "info" } });
      const receipt = { config: committed?.config, hash: committed?.hash };
      if (method === "config.set") {
        expect(result.payload).toMatchObject(receipt);
      } else {
        expect(result.error).toMatchObject({
          code: "UNAVAILABLE",
          message: expect.stringContaining(
            "persisted but was not applied to the active Gateway (failed)",
          ),
          details: { persistedConfig: receipt },
        });
        expect(getRuntimeConfig().ui?.prefs?.locale).not.toBe("fr");
      }
      expect(await fs.readFile(original.path, "utf8")).toBe("{ external editor incomplete\n");
    },
  );
});
