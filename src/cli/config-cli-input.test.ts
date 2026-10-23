import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildConfigSetOperations,
  readConfigPatchOperations,
  type ConfigPatchOptions,
} from "./config-cli-input.js";
import { parseConfigSetPath } from "./config-cli-path.js";

const DEEP_CONFIG_DEPTH = 20_000;

async function readPatch(contents: string, options: Omit<ConfigPatchOptions, "file"> = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-input-"));
  const patchPath = path.join(tempDir, "patch.json5");
  fs.writeFileSync(patchPath, contents, "utf8");
  try {
    return await readConfigPatchOperations({ ...options, file: patchPath });
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

  it("rejects patch files containing non-finite numbers", async () => {
    await expect(readPatch('{ "channels": { "custom": { "timeout": 1e999 } } }')).rejects.toThrow(
      "Value must be a finite number",
    );
  });

  it("builds operations from deeply nested input without an engine failure", async () => {
    const operations = await readPatch(
      '{"a":'.repeat(DEEP_CONFIG_DEPTH) + "1" + "}".repeat(DEEP_CONFIG_DEPTH),
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]?.setPath).toHaveLength(DEEP_CONFIG_DEPTH);
    expect(operations[0]?.value).toBe(1);
  });
});

it("replaces the leaf named by a copied --replace-path retry", async () => {
  const patch = '{"models":{"providers":{"local]service":{"models":[{"id":"qwen3:8b"}]}}}}';
  const leaf = ["models", "providers", "local]service", "models"];

  expect(
    await readPatch(patch, {
      replacePath: ['models.providers["local]service"].models'],
    }),
  ).toEqual([expect.objectContaining({ setPath: leaf, mutation: "replace" })]);
});

describe("exec provider config inputs", () => {
  const command = path.resolve("synthetic-exec-provider");
  const batchProvider = (args: string[]) =>
    buildConfigSetOperations({
      opts: {
        batchJson: JSON.stringify([
          { path: "secrets.providers.runner", provider: { source: "exec", command, args } },
        ]),
      },
    });
  it("preserves NUL in batch config input", () => {
    // Config permits NUL even though native process argv cannot carry it.
    const args = ["before\0after"];
    expect(batchProvider(args)[0]?.value).toEqual({ source: "exec", command, args });
  });

  it("rejects too many arguments in batch provider input", () => {
    expect(() => batchProvider(Array.from({ length: 129 }, () => "x"))).toThrow(
      "batch[0].provider invalid",
    );
  });

  it.each([
    [
      "unsafe command",
      "secrets.providers.runner",
      `${path.resolve("synthetic-provider")};echo`,
      "Provider builder config invalid",
    ],
    ["wrong provider path", "secrets.providers", command, "Provider builder mode requires path"],
  ])("rejects %s in provider builder input", (_name, configPath, providerCommand, error) => {
    expect(() =>
      buildConfigSetOperations({
        path: configPath,
        opts: {
          providerSource: "exec",
          providerCommand,
          providerArg: ["  literal argument  "],
        },
      }),
    ).toThrow(error);
  });
});

it.each([
  ["channels.discord.guilds", ["channels", "discord", "guilds"]],
  ['models.providers["local.service"].modals', ["models", "providers", "local.service", "modals"]],
] as const)(
  "prints an unused --replace-path retry that re-parses for %s",
  async (replacePath, segments) => {
    const patch = '{"models":{"providers":{"openai":{"models":[{"id":"gpt-4o"}]}}}}';
    const message = await readPatch(patch, { replacePath: [replacePath] }).then(
      () => "expected the unused --replace-path to be rejected",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toContain(
      `--replace-path ${replacePath} did not match any value in the input patch.`,
    );
    const printed = /--replace-path (\S+) did not match/u.exec(message)?.[1] ?? "";
    expect(parseConfigSetPath(printed)).toEqual(segments);
  },
);
