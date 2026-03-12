import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const migratePersistenceToPostgres = vi.fn();
const verifyPostgresPersistence = vi.fn();

const { defaultRuntime, runtimeErrors, runtimeLogs, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../persistence/storage.js", () => ({
  migratePersistenceToPostgres: (params: unknown) => migratePersistenceToPostgres(params),
  verifyPostgresPersistence: () => verifyPostgresPersistence(),
}));

const { registerStorageCli } = await import("./storage-cli.js");

describe("storage cli", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerStorageCli(program);
    return program;
  };

  beforeEach(() => {
    resetRuntimeCapture();
    migratePersistenceToPostgres.mockReset();
    verifyPostgresPersistence.mockReset();
  });

  it("prints migrate dry-run JSON", async () => {
    migratePersistenceToPostgres.mockResolvedValue({
      dryRun: true,
      sessionStores: 1,
      sessions: 2,
      transcripts: 1,
      transcriptEvents: 4,
      authStores: 1,
      subagentRuns: 1,
      memoryDocuments: 2,
    });

    await createProgram().parseAsync(
      ["storage", "migrate", "--to", "postgres", "--dry-run", "--json"],
      { from: "user" },
    );

    expect(migratePersistenceToPostgres).toHaveBeenCalledWith({ dryRun: true });
    expect(runtimeLogs.at(-1)).toContain('"dryRun": true');
    expect(runtimeErrors).toHaveLength(0);
  });

  it("prints verify summary in human mode", async () => {
    verifyPostgresPersistence.mockResolvedValue({
      discovered: {
        dryRun: true,
        sessionStores: 1,
        sessions: 2,
        transcripts: 1,
        transcriptEvents: 4,
        authStores: 1,
        subagentRuns: 1,
        memoryDocuments: 2,
      },
      postgres: {
        sessions: 2,
        sessionEvents: 4,
        authProfiles: 1,
        authSecrets: 1,
        subagentRuns: 1,
        memoryDocuments: 2,
      },
      matches: true,
      mismatches: [],
    });

    await createProgram().parseAsync(["storage", "verify"], { from: "user" });

    expect(runtimeLogs.at(-1)).toContain("sessions=2/2");
    expect(runtimeLogs.at(-1)).toContain("memoryDocuments=2/2");
    expect(runtimeLogs.at(-1)).toContain("matches=true");
  });

  it("fails verify when mismatches are present", async () => {
    verifyPostgresPersistence.mockResolvedValue({
      discovered: {
        dryRun: true,
        sessionStores: 1,
        sessions: 2,
        transcripts: 1,
        transcriptEvents: 4,
        authStores: 1,
        subagentRuns: 1,
        memoryDocuments: 2,
      },
      postgres: {
        sessions: 1,
        sessionEvents: 4,
        authProfiles: 1,
        authSecrets: 1,
        subagentRuns: 1,
        memoryDocuments: 2,
      },
      matches: false,
      mismatches: [
        {
          kind: "sessionStore",
          key: "/tmp/sessions.json",
          expected: 2,
          actual: 1,
        },
      ],
    });

    await expect(
      createProgram().parseAsync(["storage", "verify"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.some((line) => line.includes("expected=2 actual=1"))).toBe(true);
  });

  it("fails fast for unsupported backends", async () => {
    await expect(
      createProgram().parseAsync(["storage", "migrate", "--to", "sqlite"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain("Unsupported storage backend");
  });
});
