import { flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createOpenClawIdCeremony } from "../../lib/openclaw-id/link.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { RecoveryKitForm } from "./recovery-kit-form.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";

afterEach(cleanupSolid);

it("offers the official login save only when enabled, without confirming or submitting", async () => {
  const ceremony = createOpenClawIdCeremony();
  const kit = await ceremony.createKit();
  ceremony.discard();
  const details = { kit, hostname: "demo-e61zr.claws.test", owner: null, createdAt: new Date() };
  const continued = vi.fn();
  const saved = vi.fn();
  const validationError = vi.spyOn(console, "error");
  const added = vi.fn();
  document.addEventListener("OPButtonAdded", added);
  onTestFinished(() => {
    document.removeEventListener("OPButtonAdded", added);
    validationError.mockRestore();
  });
  const view = mountSolid(() => (
    <RecoveryKitForm
      details={details}
      accountEmail="owner@example.test"
      saved={false}
      onContinue={continued}
    >
      <RecoveryKitPanel
        details={details}
        accountEmail="owner@example.test"
        saved={false}
        onSaved={saved}
      />
      <button type="submit" disabled>
        Continue
      </button>
    </RecoveryKitForm>
  ));
  flush();
  const element = view.container.querySelector("onepassword-save-button")!;
  const button = element.shadowRoot!.querySelector<HTMLButtonElement>(
    "[data-onepassword-save-button]",
  )!;
  expect(element.getAttribute("data-onepassword-type")).toBe("login");
  expect(button.disabled).toBe(true);
  await expect
    .element(
      page.getByRole("button", { name: "Save in 1Password", exact: true, includeHidden: true }),
    )
    .not.toBeVisible();
  expect(added).toHaveBeenCalledOnce();
  const payload = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(button.value), (char) => char.charCodeAt(0))),
  );
  expect(payload.fields.map((field: { autocomplete: string }) => field.autocomplete)).toEqual([
    "username",
    "new-password",
  ]);
  expect(payload.fields[0].value).toBe("owner@example.test");
  expect(payload.fields[1].value === kit.text).toBe(true);
  expect(payload.notes).toContain("https://demo-e61zr.claws.test");
  expect(payload.notes).toContain(kit.rootFingerprint);
  expect(payload.notes).toContain("Set up this browser");
  expect(validationError).not.toHaveBeenCalled();
  // Model only the extension's supported DOM handoff; no private protocol simulation.
  button.disabled = false;
  await expect
    .element(
      page.getByRole("button", { name: "Save in 1Password", exact: true, includeHidden: true }),
    )
    .toBeVisible();
  await userEvent.click(
    page.getByRole("button", { name: "Save in 1Password", exact: true, includeHidden: true }),
  );
  expect(saved).not.toHaveBeenCalled();
  expect(continued).not.toHaveBeenCalled();
  expect(view.container.querySelector("form input[autocomplete='new-password']")).not.toBeNull();
  button.disabled = true;
  await expect
    .element(
      page.getByRole("button", { name: "Save in 1Password", exact: true, includeHidden: true }),
    )
    .not.toBeVisible();
  view.unmount();
  expect(element.hasAttribute("value")).toBe(false);
  expect(button.value).toBe("");
  expect(button.disabled).toBe(true);
});
