import fs from "node:fs/promises";
import { expect } from "vitest";

export function expectMessages(output: unknown, ...messages: string[]) {
  for (const message of messages) {
    expect(output).toHaveBeenCalledWith(expect.stringContaining(message));
  }
}

export function expectNoCalls(...outputs: unknown[]) {
  for (const output of outputs) {
    expect(output).not.toHaveBeenCalled();
  }
}

export async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}
