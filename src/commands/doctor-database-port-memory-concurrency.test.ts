import { afterEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ cpus: 1, freeBytes: 0 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => host.cpus,
}));
vi.mock("../infra/host-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/host-memory.js")>()),
  readHostFreeMemoryBytes: () => host.freeBytes,
}));

const { resolveMemoryRebuildConcurrency } =
  await import("./doctor-database-port-memory-concurrency.js");
const GiB = 1024 * 1024 * 1024;

afterEach(() => {
  host.cpus = 1;
  host.freeBytes = 0;
});

it.each([
  { cpus: 1, freeBytes: 64 * GiB, expected: 1 },
  { cpus: 2, freeBytes: 64 * GiB, expected: 1 },
  { cpus: 32, freeBytes: 0, expected: 1 },
  { cpus: 32, freeBytes: 2 * GiB, expected: 2 },
  { cpus: 32, freeBytes: 64 * GiB, expected: 4 },
])(
  "sizes memory rebuilds for $cpus CPUs and $freeBytes free bytes as $expected",
  ({ cpus, freeBytes, expected }) => {
    host.cpus = cpus;
    host.freeBytes = freeBytes;
    expect(resolveMemoryRebuildConcurrency()).toBe(expected);
  },
);
