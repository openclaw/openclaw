import fs from "node:fs/promises";
import { expect, vi } from "vitest";
import type { createConfigIO } from "./io.js";

export function registerConfigWriteWarningTests({
  itWithHome,
  createFastConfigIO,
  writeConfigFixture,
}: {
  itWithHome: (name: string, testCase: (home: string) => Promise<void>) => void;
  createFastConfigIO: (
    home: string,
    options?: Parameters<typeof createConfigIO>[0],
  ) => ReturnType<typeof createConfigIO>;
  writeConfigFixture: (home: string, config: unknown) => Promise<unknown>;
}) {
  itWithHome(
    "dedupes validation warnings across writes and reloads until config becomes clean",
    async (home) => {
      const warn = vi.fn();
      const io = createFastConfigIO(home, {
        logger: { warn, error: vi.fn() },
      });
      const staleConfig = {
        plugins: { entries: { demo: { enabled: true } } },
      };
      // An existing file keeps first-write catalog opt-outs out of these literal rewrites.
      await writeConfigFixture(home, {});

      await io.writeConfigFile(staleConfig);
      await io.writeConfigFile(staleConfig);
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);

      const rawBeforePreflight = await fs.readFile(io.configPath, "utf-8");
      await expect(
        io.writeConfigFile(
          {},
          {
            allowConfigSizeDrop: true,
            preCommitRuntimePreflight: async () => {
              throw new Error("blocked");
            },
          },
        ),
      ).rejects.toThrow("blocked");
      await expect(fs.readFile(io.configPath, "utf-8")).resolves.toBe(rawBeforePreflight);
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);

      await io.writeConfigFile(staleConfig, { skipPluginValidation: true });
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(1);

      await io.writeConfigFile({}, { allowConfigSizeDrop: true });
      await io.writeConfigFile(staleConfig);
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );
}
