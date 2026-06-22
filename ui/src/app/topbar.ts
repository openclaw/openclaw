type TopbarHost = {
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  topbarObserver: ResizeObserver | null;
};

export function observeTopbar(host: TopbarHost) {
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const topbar = host.querySelector(".topbar");
  if (!topbar) {
    return;
  }
  const update = () => {
    const { height } = topbar.getBoundingClientRect();
    host.style.setProperty("--topbar-height", `${height}px`);
  };
  update();
  host.topbarObserver = new ResizeObserver(() => update());
  host.topbarObserver.observe(topbar);
}
