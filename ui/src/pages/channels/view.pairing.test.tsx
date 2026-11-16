import type { JSX } from "@solidjs/web";
import { afterEach, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
import type { SelectPicker } from "../../components/select-picker.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import {
  pairingAccount as personal,
  pairingRequest as request,
  pairingSnapshot,
} from "./pairing.test-support.ts";
import {
  renderChannelPairingDetail,
  renderChannelPairingPrompt,
  renderChannelPairingQueue,
} from "./view.pairing.tsx";
import {
  renderChannelView,
  disposeChannelViews,
  createChannelsViewProps,
  type ChannelsViewTestOverrides,
} from "./view.test-support.ts";
import type { ChannelsProps } from "./view.types.ts";

const createProps = (overrides: ChannelsViewTestOverrides = {}): ChannelsProps =>
  createChannelsViewProps(null, pairingSnapshot(), overrides);

afterEach(() => {
  disposeChannelViews();
  document.body.replaceChildren();
});

function renderInto(
  props: ChannelsProps = createProps(),
  component: (props: ChannelsProps) => JSX.Element = renderChannelPairingQueue,
) {
  const container = document.createElement("div");
  document.body.append(container);
  renderChannelView(component, props, container);
  return container;
}

it("renders pending senders and keeps their actions current across refresh", () => {
  const onApprove = vi.fn();
  const onDismiss = vi.fn();
  const props = createProps({ onPairingApprove: onApprove, onPairingDismiss: onDismiss });
  const container = renderInto(props);

  expect(container.textContent).toContain("+15551234567");
  expect(container.textContent).toContain("Alice");
  const buttons = Array.from(container.querySelectorAll("button"));
  const approve = buttons.find((button) => button.textContent?.trim() === "Approve")!;
  const dismiss = buttons.find((button) => button.textContent?.trim() === "Dismiss")!;
  approve.click();
  dismiss.click();
  expect(onApprove).toHaveBeenCalledWith(request);
  expect(onDismiss).toHaveBeenCalledWith(request);

  const details = container.querySelector<HTMLDetailsElement>(
    ".channels-pairing-request__details",
  )!;
  details.open = true;
  const refreshed = { ...request, metadata: { name: "Alice Updated" } };
  props.channels.pairingSnapshot = {
    ...props.channels.pairingSnapshot!,
    requests: [refreshed],
  };
  renderChannelView(renderChannelPairingQueue, props, container);
  expect(container.querySelector(".channels-pairing-request__details")).toBe(details);
  expect(details.open).toBe(true);
  expect(details.textContent).toContain("Alice Updated");
  expect(container.contains(approve)).toBe(true);
  expect(container.contains(dismiss)).toBe(true);
  approve.click();
  dismiss.click();
  expect(onApprove).toHaveBeenLastCalledWith(refreshed);
  expect(onDismiss).toHaveBeenLastCalledWith(refreshed);
});

it("hides cached sender data without pairing access", () => {
  const container = renderInto(createProps({ canManagePairing: false }));

  expect(container.textContent).toContain(
    "You don’t have permission to review DM access requests.",
  );
  expect(container.querySelector(".settings-status--warn")?.textContent).toContain(
    "You don’t have permission to review DM access requests.",
  );
  expect(container.querySelector(".callout")).toBeNull();
  expect(container.textContent).not.toContain("+15551234567");
  expect(container.textContent).not.toContain("Alice");
});

it("renders notice and error feedback as status rows without nested callouts", () => {
  const noticeProps = createProps({ pairingNotice: "Request approved" });
  const noticeContainer = renderInto(noticeProps);
  const noticeSelector = '.channels-pairing-feedback[role="status"]';
  const notice = noticeContainer.querySelector(noticeSelector);

  expect(notice?.textContent).toContain("Request approved");
  expect(noticeContainer.querySelector(".callout")).toBeNull();
  noticeProps.pairingNotice = "Request dismissed";
  renderChannelView(renderChannelPairingQueue, noticeProps, noticeContainer);
  expect(noticeContainer.querySelector(noticeSelector)).toBe(notice);
  expect(notice?.textContent).toContain("Request dismissed");
  noticeProps.pairingNotice = null;
  renderChannelView(renderChannelPairingQueue, noticeProps, noticeContainer);
  expect(noticeContainer.querySelector(noticeSelector)).toBeNull();

  const errorContainer = renderInto(createProps({ channels: { pairingError: "Approval failed" } }));
  const error = errorContainer.querySelector('.channels-pairing-feedback[role="alert"]');

  expect(error?.textContent).toContain("Approval failed");
  expect(errorContainer.querySelector(".callout")).toBeNull();
});

it("uses the channel picker and clears the account filter when the channel changes", async () => {
  const onPairingFilterChange = vi.fn();
  const props = createProps({
    pairingChannelFilter: "whatsapp",
    pairingAccountFilter: "personal",
    onPairingFilterChange,
  });
  props.channels.pairingSnapshot!.accounts.push({
    ...personal,
    channel: "telegram",
    channelLabel: "Telegram",
    accountId: "work",
    accountLabel: "Work",
  });
  const container = renderInto(props);
  await updatePickers(container);
  const selects = container.querySelectorAll<SelectPicker>("openclaw-select-picker");
  const channel = selects.item(0);
  const account = selects.item(1);
  expect(selects).toHaveLength(2);
  expect(container.querySelectorAll("select.settings-select")).toHaveLength(0);
  await openPicker(account);
  expect(
    account.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
  ).toBe("personal");
  await choosePickerValue(channel, "telegram");
  expect(onPairingFilterChange).toHaveBeenCalledWith("telegram", null);
});

it("disables every request action while one mutation is active", () => {
  const props = createProps({
    channels: { pairingBusy: { requestId: request.requestId, action: "approve" } },
  });
  props.channels.pairingSnapshot!.requests.push({
    ...request,
    requestId: "other-request",
    senderId: "987654321",
  });
  const container = renderInto(props);
  const actionButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => /^(Approve|Dismiss) /u.test(button.getAttribute("aria-label") ?? ""),
  );

  expect(actionButtons).toHaveLength(4);
  expect(actionButtons.every((button) => button.disabled)).toBe(true);
});

it.each(["approve", "dismiss"] as const)(
  "shows progress only for the pending %s action and restores it on failure",
  async (kind) => {
    const held = Promise.withResolvers<unknown>();
    const client = createTestGatewayClient(() => held.promise);
    const { gateway } = createApplicationGateway(
      createApplicationGatewaySnapshot({ client, phase: "connected" }),
    );
    const channels = createChannelCapability(gateway);
    const props = createProps({
      pairingPrompt: { kind, request, notify: false, bootstrapCommandOwner: false },
    });
    props.channels = channels.state;
    channels.state.pairingSnapshot = pairingSnapshot();
    let mutation: Promise<unknown> = Promise.resolve();
    props.onPairingPromptConfirm = () => {
      mutation =
        kind === "approve"
          ? channels.approvePairing({ ...request, notify: false, bootstrapCommandOwner: false })
          : channels.dismissPairing(request);
    };
    const view = (current: ChannelsProps) => (
      <>
        {renderChannelPairingQueue(current)}
        {renderChannelPairingPrompt(current)}
      </>
    );
    const container = renderInto(props, view);
    const confirm = container.querySelector<HTMLButtonElement>(
      "openclaw-modal-actions button:last-child",
    )!;
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".channels-pairing-request__actions button"),
    );
    try {
      confirm.click();
      renderChannelView(view, props, container);
      expect(confirm.textContent?.trim()).toBe("Loading…");
      expect(buttons.map((button) => button.textContent?.trim())).toEqual(
        kind === "approve" ? ["Loading…", "Dismiss"] : ["Approve", "Loading…"],
      );
      expect(buttons.every((button) => button.disabled)).toBe(true);
      held.reject(new Error("Request failed"));
      await mutation;
      renderChannelView(view, props, container);
      expect(confirm.textContent?.trim()).toBe(kind === "approve" ? "Approve" : "Dismiss");
      expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Approve", "Dismiss"]);
      expect(buttons.every((button) => !button.disabled)).toBe(true);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Request failed");
    } finally {
      held.resolve({});
      await mutation;
      channels.dispose();
    }
  },
);

it("shows explicit notification and first-owner choices for an admin", () => {
  const container = renderInto(
    createProps({
      pairingPrompt: {
        kind: "approve",
        request,
        notify: false,
        bootstrapCommandOwner: false,
      },
    }),
    renderChannelPairingPrompt,
  );

  expect(container.textContent).toContain("Notify the requester after approval");
  expect(container.textContent).toContain("Also make this sender the first command owner");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
});

it("links a channel account detail back to the filtered request queue", () => {
  const review = vi.fn();
  const props = createProps({ onPairingReviewAccount: review });
  const detail = (current: ChannelsProps) => renderChannelPairingDetail("whatsapp", current);
  const container = renderInto(props, detail);

  expect(container.textContent).toContain("1 pending");
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Review requests",
  );
  button?.click();
  expect(review).toHaveBeenCalledWith("whatsapp", "personal");

  props.channels.pairingSnapshot = {
    ...props.channels.pairingSnapshot!,
    accounts: structuredClone(props.channels.pairingSnapshot!.accounts),
    requests: [],
  };
  renderChannelView(detail, props, container);
  expect(container.querySelector("button")).toBe(button);
  expect(container.textContent).toContain("No pending requests");
  expect(container.textContent).not.toContain("1 pending");
});
