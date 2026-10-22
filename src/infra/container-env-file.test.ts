import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createContainerEnvFile, withContainerEnvFile } from "./container-env-file.js";

const [before, after] = ["synthetic-before", "synthetic-after"];
type InvalidEntry = [string, string, string[], string[]];
const invalidKeys = ["", "1INVALID", "BAD-NAME", "BAD\nNAME", " LEADING_SPACE"];

async function expectRemoved(file: string) {
  for (const target of [file, path.dirname(file)]) {
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

it("preserves values and private permissions, then removes both file and directory", async () => {
  const environment = {
    PLAIN: "test",
    SPACES: "two words",
    EQUALS: "left=middle=right",
    EMPTY: "",
    WHITESPACE: "  padded  ",
    UTF8: "test-🦞-環境",
  };
  const staged = await createContainerEnvFile(environment);
  try {
    expect(await fs.readFile(staged.path, "utf8")).toBe(
      "EMPTY=\nEQUALS=left=middle=right\nPLAIN=test\nSPACES=two words\nUTF8=test-🦞-環境\nWHITESPACE=  padded  \n",
    );
    expect((await fs.stat(path.dirname(staged.path))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(staged.path)).mode & 0o777).toBe(0o600);
  } finally {
    await staged.cleanup();
  }
  await expectRemoved(staged.path);
  await expect(staged.cleanup()).resolves.toBeUndefined();
});

it.each<InvalidEntry>([
  ...invalidKeys.map((key): InvalidEntry => [key, before, ["environment variable name"], [before]]),
  ...["\n", "\r"].map((separator): InvalidEntry => [
    "MULTILINE",
    before + separator + after,
    ["MULTILINE", "single-line", "--env-file"],
    [before, after],
  ]),
  ["NUL", before + "\0after", ["NUL"], [before]],
])("rejects %s without disclosure", async (key, value, messages, hidden) => {
  const error = await createContainerEnvFile({ [key]: value }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  for (const text of messages) {
    expect(message).toContain(text);
  }
  for (const text of hidden) {
    expect(message).not.toContain(text);
  }
});

it.each(["completed", "failed"])("removes the env file after the %s callback", async (outcome) => {
  let stagedPath = "";
  const operationError = new Error("synthetic callback failure");
  const operation = withContainerEnvFile({ CALLBACK: "synthetic" }, async (file) => {
    stagedPath = file;
    expect(await fs.readFile(file, "utf8")).toBe("CALLBACK=synthetic\n");
    if (outcome === "failed") {
      throw operationError;
    }
    return "synthetic callback result";
  });
  if (outcome === "failed") {
    await expect(operation).rejects.toBe(operationError);
  } else {
    await expect(operation).resolves.toBe("synthetic callback result");
  }
  await expectRemoved(stagedPath);
});
