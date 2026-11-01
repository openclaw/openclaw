import { afterEach, expect, it, vi } from "vitest";
import { openClawIdDocumentConfig } from "./openclaw-id-document.ts";

const attribute = "data-openclaw-bootstrap-config";
afterEach(() => {
  document.documentElement.removeAttribute(attribute);
  vi.restoreAllMocks();
});

it.each([undefined, false, true])(
  "reads only the served explicit ID opt-in: %s",
  (openclawIdEnabled) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    document.documentElement.setAttribute(
      attribute,
      JSON.stringify({ basePath: "/claw", openclawIdEnabled }),
    );
    expect(openClawIdDocumentConfig()).toEqual(
      openclawIdEnabled ? { basePath: "/claw", openclawIdEnabled: true } : null,
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([null, "{"])("keeps an absent or invalid bootstrap inert: %s", (raw) => {
  if (raw !== null) {
    document.documentElement.setAttribute(attribute, raw);
  }
  expect(openClawIdDocumentConfig()).toBeNull();
});
