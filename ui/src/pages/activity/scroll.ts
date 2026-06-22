type ActivityScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  activityScrollFrame: number | null;
  activityAutoFollow?: boolean;
  activityAtBottom?: boolean;
};

export function scheduleActivityScroll(host: ActivityScrollHost, force = false) {
  if (host.activityScrollFrame) {
    cancelAnimationFrame(host.activityScrollFrame);
  }
  void host.updateComplete.then(() => {
    host.activityScrollFrame = requestAnimationFrame(() => {
      host.activityScrollFrame = null;
      const container = host.querySelector(".activity-stream") as HTMLElement | null;
      if (!container) {
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick =
        force ||
        (host.activityAutoFollow !== false &&
          (host.activityAtBottom !== false || distanceFromBottom < 120));
      if (!shouldStick) {
        return;
      }
      container.scrollTop = container.scrollHeight;
      host.activityAtBottom = true;
    });
  });
}

export function handleActivityScroll(host: ActivityScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.activityAtBottom = distanceFromBottom < 120;
}
