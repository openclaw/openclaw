import { isNativeEmbedHost, isNativeWebChromeHost } from "../../../app/native-web-chrome.ts";
import { isIosBrowserPlatform } from "../../../lib/browser-platform.ts";

export function useSingleAttachmentPicker(): boolean {
  if (!isIosBrowserPlatform() || isNativeEmbedHost() || isNativeWebChromeHost()) {
    return false;
  }
  // Safari's iOS upload panel already offers library, camera, and files.
  // Width/touch are not picker capabilities. Other browsers and WKWebView hosts
  // can replace that panel; retain their explicit input paths unless verified.
  // This conservative Safari identity hint is not proof of a native picker contract.
  const ua = navigator.userAgent;
  return /AppleWebKit\//u.test(ua) && /Version\/[\d.]+(?: Mobile\/\S+)? Safari\/[\d.]+$/u.test(ua);
}
