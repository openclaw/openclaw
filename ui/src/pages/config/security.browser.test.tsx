import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { Security } from "./security.tsx";

it.each([
  { profile: "", busy: false, next: "full", writes: 1 },
  { profile: "full", busy: false, next: "", writes: 1 },
  { profile: "", busy: true, next: "full", writes: 0 },
])("selects '$next' from '$profile' while busy=$busy", async ({ profile, busy, next, writes }) => {
  const { page } = await import("vitest/browser");
  const container = document.createElement("div");
  const onToolProfileChange = vi.fn();
  document.body.append(container);
  const { unmount } = mountSolid(
    () => (
      <Security
        security={{
          gatewayAuth: "token",
          gatewayAuthReported: false,
          networkAccess: { kind: "loopback" },
          execPolicy: "allowlist",
          browserEnabled: true,
          toolProfile: profile,
        }}
        configBusy={busy}
        onToolProfileChange={onToolProfileChange}
        buildEditor={() => undefined}
      />
    ),
    { container },
  );
  try {
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe(profile);
    expect(select.disabled).toBe(busy);
    expect(onToolProfileChange).not.toHaveBeenCalled();
    if (!busy) {
      await page.elementLocator(select).selectOptions(next);
    }
    flush();
    expect(onToolProfileChange).toHaveBeenCalledTimes(writes);
    if (writes) {
      expect(onToolProfileChange).toHaveBeenCalledWith(next);
    }
  } finally {
    unmount();
    container.remove();
  }
});
