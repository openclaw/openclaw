import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot } from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

const primePostgresAuthRuntimeStateMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../persistence/runtime.js", () => ({
  primePostgresAuthRuntimeState: primePostgresAuthRuntimeStateMock,
}));

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command postgres auth priming", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
  });

  beforeEach(() => {
    primePostgresAuthRuntimeStateMock.mockClear();
  });

  it("primes postgres auth runtime before doctor auth checks", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: { mode: "local" },
        persistence: {
          backend: "postgres",
          postgres: {
            url: "postgresql://openclaw:test@localhost/openclaw",
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(primePostgresAuthRuntimeStateMock).toHaveBeenCalledWith({
      config: expect.objectContaining({
        persistence: {
          backend: "postgres",
          postgres: {
            url: "postgresql://openclaw:test@localhost/openclaw",
          },
        },
      }),
      env: process.env,
    });
  });
});
