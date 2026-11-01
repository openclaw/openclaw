import { expect } from "vitest";

type FileSnapshot = { bytes: Buffer | null };

export function expectBytesEqual(actual: Buffer | null, expected: Buffer | null, label: string) {
  if (actual === null || expected === null) {
    expect(actual, `${label}: file presence`).toBe(expected);
  } else {
    expect(actual.equals(expected), `${label}: bytes`).toBe(true);
  }
}

export function expectFilesEqual<T extends FileSnapshot>(actual: T[], expected: T[] | undefined) {
  expect(expected, "Expected the captured file snapshot").toBeDefined();
  expect(actual.map(({ bytes: _bytes, ...metadata }) => metadata)).toEqual(
    expected!.map(({ bytes: _bytes, ...metadata }) => metadata),
  );
  actual.forEach(({ bytes }, index) =>
    expectBytesEqual(bytes, expected![index]!.bytes, `snapshot file ${index}`),
  );
}

export function expectFamilyEqual<T extends FileSnapshot>(
  actual: { entries: string[]; files: T[] },
  expected: { entries: string[]; files: T[] },
) {
  expect(actual.entries).toEqual(expected.entries);
  expectFilesEqual(actual.files, expected.files);
}
