type SessionHeaderLink = { url: string; label: string };
type SessionHeaderLinkContext = {
  signal: AbortSignal;
  presented: boolean;
  props: { session?: { conversationLink?: SessionHeaderLink } };
};
type SessionHeaderLinkMount = (
  container: HTMLElement,
  initialContext: SessionHeaderLinkContext,
) => {
  update?: (context: SessionHeaderLinkContext) => void;
  dispose?: () => void;
} | void;

/** A plugin-owned accessory with the standard header link appearance and direct navigation. */
export function createSessionHeaderLink(
  resolve: (
    session: NonNullable<SessionHeaderLinkContext["props"]["session"]>,
  ) => SessionHeaderLink | undefined,
): SessionHeaderLinkMount {
  return (container, initialContext) => {
    const link = document.createElement("a");
    link.className = "plugin-session-header-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    // Header links navigate directly, bypassing the host's link-reader preview/menu.
    link.dataset.linkReaderExternal = "";
    let disposed = false;
    const dispose = () => {
      disposed = true;
      link.removeAttribute("href");
      link.remove();
    };
    const update = (context: SessionHeaderLinkContext) => {
      if (disposed) {
        return;
      }
      const destination =
        context.presented && !context.signal.aborted && context.props.session
          ? resolve(context.props.session)
          : undefined;
      const url = destination ? URL.parse(destination.url) : null;
      if (!destination || !url || (url.protocol !== "https:" && url.protocol !== "http:")) {
        link.removeAttribute("href");
        link.remove();
        return;
      }
      link.href = url.href;
      link.textContent = `${destination.label} ↗`;
      if (link.parentNode !== container) {
        container.append(link);
      }
    };
    initialContext.signal.addEventListener("abort", dispose, { once: true });
    update(initialContext);
    return {
      update,
      dispose() {
        initialContext.signal.removeEventListener("abort", dispose);
        dispose();
      },
    };
  };
}
