import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildConfigSetOperations, readConfigPatchOperations } from "./config-cli-input.js";
import { parseConfigSetPath } from "./config-cli-path.js";

const DEEP_CONFIG_DEPTH = 20_000;

function nestedConfigRaw(leaf: string): string {
  return '{"a":'.repeat(DEEP_CONFIG_DEPTH) + leaf + "}".repeat(DEEP_CONFIG_DEPTH);
}

async function withPatchFile<T>(
  contents: string,
  run: (patchPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-input-"));
  const patchPath = path.join(tempDir, "patch.json5");
  fs.writeFileSync(patchPath, contents, "utf8");
  try {
    return await run(patchPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("readConfigPatchOperations", () => {
  it.each([
    {
      label: "malformed bytes",
      chunks: [Buffer.from('{name:"'), Buffer.from([0xff]), Buffer.from('"}')],
      error: "--stdin must be valid UTF-8",
    },
    {
      label: "valid split Unicode",
      chunks: [
        Buffer.from('{name:"中文 😀 \uFFFD"}').subarray(0, 9),
        Buffer.from('{name:"中文 😀 \uFFFD"}').subarray(9),
      ],
      value: "中文 😀 \uFFFD",
    },
  ])("reads stdin as bytes for $label", async ({ chunks, error, value }) => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from(chunks) });
    try {
      const result = readConfigPatchOperations({ stdin: true });
      if (error) {
        await expect(result).rejects.toThrow(error);
      } else {
        await expect(result).resolves.toMatchObject([{ setPath: ["name"], value }]);
      }
    } finally {
      if (original) {
        Object.defineProperty(process, "stdin", original);
      }
    }
  });

  it.each(['{ "channels": { "custom": { "timeout": 1e999 } } }'])(
    "rejects patch files containing non-finite numbers",
    async (contents) => {
      await withPatchFile(contents, async (patchPath) => {
        await expect(readConfigPatchOperations({ file: patchPath })).rejects.toThrow(
          "Value must be a finite number",
        );
      });
    },
  );

  it("builds operations from deeply nested input without an engine failure", async () => {
    await withPatchFile(nestedConfigRaw("1"), async (patchPath) => {
      const operations = await readConfigPatchOperations({ file: patchPath });

      expect(operations).toHaveLength(1);
      expect(operations[0]?.setPath).toHaveLength(DEEP_CONFIG_DEPTH);
      expect(operations[0]?.value).toBe(1);
    });
  });
});

// The replacement guard tells the user to retry with the path it printed; that retry has to
// survive the shell and still match the leaf it named.
describe("copied --replace-path retry", () => {
  const patch = '{"models":{"providers":{"local]service":{"models":[{"id":"qwen3:8b"}]}}}}';
  const leaf = ["models", "providers", "local]service", "models"];

  it("replaces the leaf the refusal named", async () => {
    await withPatchFile(patch, async (patchPath) => {
      const operations = await readConfigPatchOperations({
        file: patchPath,
        replacePath: ['models.providers["local]service"].models'],
      });

      expect(operations).toHaveLength(1);
      expect(operations[0]?.setPath).toEqual(leaf);
      expect(operations[0]?.mutation).toBe("replace");
    });
  });
});

describe("exec provider config inputs", () => {
  it("preserves NUL in batch config input", () => {
    // Config permits NUL even though native process argv cannot carry it.
    const args = ["before\0after"];
    const command = path.resolve("synthetic-exec-provider");
    const operations = buildConfigSetOperations({
      opts: {
        batchJson: JSON.stringify([
          { path: "secrets.providers.runner", provider: { source: "exec", command, args } },
        ]),
      },
    });

    expect(operations[0]?.value).toEqual({ source: "exec", command, args });
  });

  it.each([{ name: "too many arguments", args: Array.from({ length: 129 }, () => "x") }])(
    "rejects a $name in batch provider input",
    ({ args }) => {
      expect(() =>
        buildConfigSetOperations({
          opts: {
            batchJson: JSON.stringify([
              {
                path: "secrets.providers.runner",
                provider: {
                  source: "exec",
                  command: path.resolve("synthetic-exec-provider"),
                  args,
                },
              },
            ]),
          },
        }),
      ).toThrow("batch[0].provider invalid");
    },
  );

  it.each([
    {
      name: "unsafe command",
      providerCommand: `${path.resolve("synthetic-provider")};echo`,
      error: "Provider builder config invalid",
    },
    {
      name: "wrong provider path",
      configPath: "secrets.providers",
      error: "Provider builder mode requires path",
    },
  ])("rejects $name in provider builder input", (testCase) => {
    expect(() =>
      buildConfigSetOperations({
        path: testCase.configPath ?? "secrets.providers.runner",
        opts: {
          providerSource: "exec",
          providerCommand: testCase.providerCommand ?? path.resolve("synthetic-exec-provider"),
          providerArg: ["  literal argument  "],
        },
      }),
    ).toThrow(testCase.error);
  });
});

// The unused-path error echoes the argument the user has to correct, so the printed path must be
// one this command's own parser accepts: joining on dots drops the brackets a quoted key needs,
// which leaves a retry that can never match no matter how often it is pasted back.
describe("unused --replace-path echo", () => {
  const patch = '{"models":{"providers":{"openai":{"models":[{"id":"gpt-4o"}]}}}}';

  async function rejectionMessage(patchPath: string, replacePath: string): Promise<string> {
    return await readConfigPatchOperations({ file: patchPath, replacePath: [replacePath] }).then(
      () => "expected the unused --replace-path to be rejected",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  it.each([
    {
      name: "plain key",
      replacePath: "channels.discord.guilds",
      echo: "channels.discord.guilds",
      segments: ["channels", "discord", "guilds"],
    },
    {
      name: "key holding a dot",
      replacePath: 'models.providers["local.service"].modals',
      echo: 'models.providers["local.service"].modals',
      segments: ["models", "providers", "local.service", "modals"],
    },
  ])("prints a retry that re-parses for a $name", async ({ replacePath, echo, segments }) => {
    await withPatchFile(patch, async (patchPath) => {
      const message = await rejectionMessage(patchPath, replacePath);

      expect(message).toContain(
        `--replace-path ${echo} did not match any value in the input patch.`,
      );
      const printed = /--replace-path (\S+) did not match/u.exec(message)?.[1] ?? "";
      expect(parseConfigSetPath(printed)).toEqual(segments);
    });
  });
});
