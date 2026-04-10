import type { Mock } from "vitest";
import { vi } from "vitest";

export const terminalNoteMock: Mock<(...args: unknown[]) => unknown> = vi.fn();

function isNoteSuppressedByEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => {
    if (isNoteSuppressedByEnv(process.env.OPENCLAW_SUPPRESS_NOTES)) {
      return;
    }
    return terminalNoteMock(...args);
  },
}));

export async function loadDoctorCommandForTest(params?: { unmockModules?: string[] }) {
  vi.resetModules();
  vi.doMock("../terminal/note.js", () => ({
    note: (...args: unknown[]) => {
      if (isNoteSuppressedByEnv(process.env.OPENCLAW_SUPPRESS_NOTES)) {
        return;
      }
      return terminalNoteMock(...args);
    },
  }));
  for (const modulePath of params?.unmockModules ?? []) {
    vi.doUnmock(modulePath);
  }
  const { doctorCommand } = await import("./doctor.js");
  terminalNoteMock.mockClear();
  return doctorCommand;
}
