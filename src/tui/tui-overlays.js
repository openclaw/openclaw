export function createOverlayHandlers(host, fallbackFocus) {
    const openOverlay = (component) => {
        host.showOverlay(component);
    };
    const closeOverlay = () => {
        if (host.hasOverlay()) {
            host.hideOverlay();
            return;
        }
        host.setFocus(fallbackFocus);
    };
    return { openOverlay, closeOverlay };
}
