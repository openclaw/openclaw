import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "./io.factory.js";
import { withConfigWriteLock } from "./write-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("config prefix recovery publication", () => {
  it.each(["source", "owner"] as const)(
    "refuses prefix recovery when %s changes while preserving the original",
    async (changed) => {
      const root = tempDirs.make("openclaw-prefix-publication-");
      const configPath = path.join(root, "openclaw.json");
      const original = 'synthetic warning\n{"gateway":{"mode":"local"}}\n';
      const replacement = '{"gateway":{"mode":"local","port":19876}}\n';
      const env = { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
      let ownerCurrent = true;
      const io = createConfigIO({
        configPath,
        env,
        observe: false,
        pluginValidation: "core-only",
        fs: {
          ...fs,
          promises: {
            ...fs.promises,
            writeFile: new Proxy(fs.promises.writeFile, {
              async apply(target, thisArg, args) {
                const result = await Reflect.apply(target, thisArg, args);
                if (typeof args[0] === "string" && args[0].startsWith(`${configPath}.clobbered.`)) {
                  if (changed === "source") {
                    await fsp.writeFile(configPath, replacement);
                  } else {
                    ownerCurrent = false;
                  }
                }
                return result;
              },
            }),
          },
        },
      });
      await fsp.writeFile(configPath, original);
      const snapshot = await io.readConfigFileSnapshot();
      await expect(
        withConfigWriteLock(
          configPath,
          () => io.recoverConfigFromJsonRootSuffix(snapshot),
          env,
          () => {
            if (!ownerCurrent) {
              throw new Error("synthetic config owner lost");
            }
          },
        ),
      ).rejects.toThrow(changed === "source" ? /config.*changed/i : "synthetic config owner lost");
      expect(await fsp.readFile(configPath, "utf8")).toBe(
        changed === "source" ? replacement : original,
      );
      const clobbered = (await fsp.readdir(root)).filter((name) =>
        name.startsWith("openclaw.json.clobbered."),
      );
      expect(clobbered).toHaveLength(1);
      expect(await fsp.readFile(path.join(root, clobbered[0]!), "utf8")).toBe(original);
    },
  );
});
