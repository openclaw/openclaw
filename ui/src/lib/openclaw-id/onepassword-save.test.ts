import { describe, expect, it, vi } from "vitest";
import { mountOnePasswordKit } from "./onepassword-save.ts";

// The official package exposes no listener disposal. Measure its exact limitation,
// while proving our retained DOM cannot keep any kit payload after disposal.
describe("official 1Password kit adapter lifecycle", () => {
  it("adds exactly two vendor global listeners per mount and scrubs all payload DOM", () => {
    const documentAdds = vi.spyOn(document, "addEventListener");
    const bodyAdds = vi.spyOn(document.body, "addEventListener");
    const documentRemoves = vi.spyOn(document, "removeEventListener");
    const bodyRemoves = vi.spyOn(document.body, "removeEventListener");
    const validationError = vi.spyOn(console, "error");
    const host = document.createElement("div");
    document.body.append(host);
    try {
      for (let index = 0; index < 4; index++) {
        const enabled = vi.fn();
        const dispose = mountOnePasswordKit(
          host,
          {
            title: "OpenClaw recovery kit · demo",
            username: "OpenClaw recovery kit · demo",
            code: "SYNTHETIC-UNUSED-KIT",
            notes: "Recovery kit ID: synthetic; Set up this browser",
            url: "https://demo.claws.test",
          },
          enabled,
        );
        const element = host.querySelector("onepassword-save-button")!;
        const button = element.shadowRoot!.querySelector<HTMLButtonElement>(
          "[data-onepassword-save-button]",
        )!;
        expect(enabled).toHaveBeenLastCalledWith(false);
        expect(element.getAttribute("value")).toBe(button.value);
        const encoded = button.value;
        dispose();
        expect(host.children).toHaveLength(0);
        expect(element.getAttribute("value")).toBeNull();
        expect(button.value).toBe("");
        const attributes = [element, ...element.shadowRoot!.querySelectorAll("*")].flatMap((node) =>
          [...node.attributes].map((attribute) => attribute.value),
        );
        expect(
          attributes.some(
            (value) => value.includes(encoded) || value.includes("SYNTHETIC-UNUSED-KIT"),
          ),
        ).toBe(false);
        // An extension may respond after the owner leaves the step. Its listener must not throw.
        const listener = documentAdds.mock.calls.findLast(([name]) => name === "OPButtonEvent")![1];
        const response = new CustomEvent("OPButtonEvent", {
          detail: {
            buttonId: button.id,
            header: "Saved",
            body: [],
            hideCta: true,
            openModal: false,
          },
        });
        if (typeof listener === "function") {
          expect(() => listener.call(document, response)).not.toThrow();
        }
        expect(documentAdds.mock.calls.filter(([name]) => name === "OPButtonEvent")).toHaveLength(
          index + 1,
        );
        expect(bodyAdds.mock.calls.filter(([name]) => name === "click")).toHaveLength(index + 1);
      }
      expect(documentRemoves.mock.calls.filter(([name]) => name === "OPButtonEvent")).toHaveLength(
        0,
      );
      expect(bodyRemoves.mock.calls.filter(([name]) => name === "click")).toHaveLength(0);
      expect(validationError).not.toHaveBeenCalled();
    } finally {
      // Test-only cleanup of observed callbacks; production never intercepts vendor listeners.
      for (const [name, callback] of documentAdds.mock.calls) {
        if (name === "OPButtonEvent") {
          document.removeEventListener(name, callback);
        }
      }
      for (const [name, callback] of bodyAdds.mock.calls) {
        if (name === "click") {
          document.body.removeEventListener(name, callback);
        }
      }
      host.remove();
      vi.restoreAllMocks();
    }
  });
});
