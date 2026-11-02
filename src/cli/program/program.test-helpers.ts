import { expect, vi, type MockInstance } from "vitest";

export function expectNoCalls(...mocks: MockInstance[]): void {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export async function captureStdout(run: () => unknown): Promise<string> {
  let output = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((...args) => {
    const [chunk, encodingOrCallback, callback] = args;
    output += String(chunk);
    (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
    return true;
  });
  try {
    await run();
    return output;
  } finally {
    write.mockRestore();
  }
}
