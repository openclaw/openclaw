export function isRemoteControlUiIngress(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-openclaw-remote-ingress") === "true"
  );
}
