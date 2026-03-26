import { vi } from "vitest";

export const terminalNoteMock = vi.fn();

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => terminalNoteMock(...args),
}));

export async function loadDoctorCommandForTest(params?: { unmockModules?: string[] }) {
  vi.resetModules();
  for (const modulePath of params?.unmockModules ?? []) {
    vi.doUnmock(modulePath);
  }
  const { doctorCommand } = await import("./doctor.js");
  terminalNoteMock.mockClear();
  return doctorCommand;
}
