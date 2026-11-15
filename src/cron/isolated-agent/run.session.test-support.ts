import { vi } from "vitest";
import {
  loadSessionEntryMock,
  patchSessionEntryMock,
  resolveCronSessionMock,
} from "./run.test-harness.js";

export async function realCronSession() {
  const accessor = await vi.importActual<
    typeof import("../../config/sessions/session-accessor.js")
  >("../../config/sessions/session-accessor.js");
  const session = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    accessor,
    install() {
      resolveCronSessionMock.mockImplementation(session.prepareCronSession);
      loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
      patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
    },
  };
}
