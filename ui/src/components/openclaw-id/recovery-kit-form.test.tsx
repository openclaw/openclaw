import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeKit,
  deriveRootSigner,
  formatEd25519PublicKey,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { createOpenClawIdCeremony } from "../../lib/openclaw-id/link.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { RecoveryKitForm } from "./recovery-kit-form.tsx";
import { RecoveryKitPanel } from "./recovery-kit-panel.tsx";

// Mount the production panel and its native form around a newly generated, unused kit.
async function mountKit(accountEmail: string | null = "owner@example.test") {
  const ceremony = createOpenClawIdCeremony();
  const kit = await ceremony.createKit();
  ceremony.discard();
  const details = {
    kit,
    hostname: "demo-e61zr.claws.test",
    owner: "Example owner",
    createdAt: new Date(),
  };
  const continued = vi.fn();
  const view = mountSolid(() => {
    const [saved, setSaved] = createSignal(false);
    return (
      <RecoveryKitForm
        details={details}
        accountEmail={accountEmail}
        saved={saved()}
        onContinue={continued}
      >
        <RecoveryKitPanel
          details={details}
          accountEmail={accountEmail}
          saved={saved()}
          onSaved={setSaved}
        />
        <button type="submit" disabled={!saved()}>
          Continue
        </button>
      </RecoveryKitForm>
    );
  });
  flush();
  const form = view.container.querySelector("form")!;
  const username = form.querySelector<HTMLInputElement>('[autocomplete="username"]')!;
  const password = form.querySelector<HTMLInputElement>('[autocomplete="new-password"]')!;
  return { ...view, kit, continued, form, username, password };
}

afterEach(cleanupSolid);

describe("native recovery kit form", () => {
  it("uses native credential semantics and the exact importable code, not the export document", async () => {
    const view = await mountKit();
    expect(view.form.id).toBe("openclaw-recovery-kit");
    expect(view.form.name).toBe("openclaw-recovery-kit");
    expect(view.username.name).toBe("username");
    expect(view.username.value).toBe("owner@example.test");
    expect(view.username.readOnly).toBe(true);
    expect(view.password.name).toBe("password");
    expect(view.password.type).toBe("password");
    expect(view.password.readOnly).toBe(true);
    expect(view.password.value === view.kit.text).toBe(true);
    // The loader's enrollWithKit uses this same decoder and root derivation.
    const secret = await decodeKit(view.password.value);
    const root = await deriveRootSigner(secret);
    secret.fill(0);
    expect(formatEd25519PublicKey(root.publicKey)).toBe(view.kit.rootPub);
    expect(view.continued).not.toHaveBeenCalled();
    expect(view.form.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("reveals only on request, keeps confirmation explicit and continues once through submit", async () => {
    const view = await mountKit(null);
    expect(view.username.value).toBe("OpenClaw recovery kit · demo");
    view.getByRole("button", { name: "Show" }).click();
    flush();
    expect(view.password.type).toBe("text");
    expect(view.password.value === view.kit.text).toBe(true);
    view.getByRole("button", { name: "Hide" }).click();
    flush();
    expect(view.password.type).toBe("password");
    // Even requestSubmit cannot bypass the saved checkbox.
    view.form.requestSubmit();
    expect(view.continued).not.toHaveBeenCalled();
    view.getByRole("checkbox").click();
    flush();
    expect(view.continued).not.toHaveBeenCalled();
    const submit = vi.fn((event: SubmitEvent) => ({
      prevented: event.defaultPrevented,
      exactCode: view.password.value === view.kit.text,
    }));
    view.form.addEventListener("submit", submit);
    view.getByRole("button", { name: "Continue" }).click();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.results[0]?.value).toEqual({ prevented: true, exactCode: true });
    await vi.waitFor(() => expect(view.continued).toHaveBeenCalledOnce());
    view.form.requestSubmit();
    await vi.waitFor(() => expect(view.continued).toHaveBeenCalledOnce());
    view.form.removeEventListener("submit", submit);
  });

  it("cancels a queued continuation if the kit is discarded during submit", async () => {
    const view = await mountKit();
    view.getByRole("checkbox").click();
    flush();
    view.form.addEventListener("submit", () => view.unmount(), { once: true });
    view.getByRole("button", { name: "Continue" }).click();
    // Wait one posted task, not a timer, so an incorrectly retained submit runs first.
    await new Promise<void>((resolve) => {
      const task = new MessageChannel();
      task.port1.addEventListener("message", () => {
        task.port1.close();
        task.port2.close();
        resolve();
      });
      task.port1.start();
      task.port2.postMessage(null);
    });
    expect(view.continued).not.toHaveBeenCalled();
    expect(view.password.value).toBe("");
  });

  it("clears both retained input nodes when the kit is discarded", async () => {
    const view = await mountKit();
    view.getByRole("button", { name: "Show" }).click();
    flush();
    view.unmount();
    for (const input of [view.username, view.password]) {
      expect(input.value).toBe("");
      expect(input.defaultValue).toBe("");
    }
    expect(view.password.type).toBe("password");
    view.form.requestSubmit();
    expect(view.continued).not.toHaveBeenCalled();
  });
});
