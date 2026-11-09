import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createOpenClawIdCeremony } from "../../lib/openclaw-id/link.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { RecoveryKitForm } from "./recovery-kit-form.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";

afterEach(cleanupSolid);

it("emits a real submit with credential fields only after explicit confirmation", async () => {
  const ceremony = createOpenClawIdCeremony();
  const kit = await ceremony.createKit();
  ceremony.discard();
  const details = { kit, hostname: "demo-e61zr.claws.test", owner: null, createdAt: new Date() };
  const continued = vi.fn(() => view.unmount());
  const view = mountSolid(() => {
    const [saved, setSaved] = createSignal(false);
    return (
      <RecoveryKitForm
        details={details}
        accountEmail="owner@example.test"
        saved={saved()}
        onContinue={continued}
      >
        <RecoveryKitPanel details={details} saved={saved()} onSaved={setSaved} />
        <button type="submit" disabled={!saved()}>
          Continue
        </button>
      </RecoveryKitForm>
    );
  });
  const form = view.container.querySelector("form")!;
  const username = form.querySelector<HTMLInputElement>('input[name="username"]')!;
  const password = form.querySelector<HTMLInputElement>('input[name="password"]')!;
  expect(username.autocomplete).toBe("username");
  expect(username.readOnly).toBe(true);
  expect(password.autocomplete).toBe("new-password");
  expect(password.readOnly).toBe(true);
  expect(password.type).toBe("password");
  expect(password.value === kit.text).toBe(true);
  expect(continued).not.toHaveBeenCalled();
  const submit = vi.fn((event: SubmitEvent) => ({
    trusted: event.isTrusted,
    prevented: event.defaultPrevented,
    exactCode: password.value === kit.text,
  }));
  document.addEventListener("submit", submit);
  await userEvent.click(page.getByRole("button", { name: "Show", exact: true }));
  expect(password.type).toBe("text");
  expect(submit).not.toHaveBeenCalled();
  await userEvent.click(page.getByRole("switch"));
  expect(continued).not.toHaveBeenCalled();
  await userEvent.click(page.getByRole("button", { name: "Continue", exact: true }));
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.results[0]?.value).toEqual({
    trusted: true,
    prevented: true,
    exactCode: true,
  });
  await vi.waitFor(() => expect(continued).toHaveBeenCalledOnce());
  document.removeEventListener("submit", submit);
  view.unmount();
  flush();
  expect(password.value).toBe("");
  expect(username.value).toBe("");
});
