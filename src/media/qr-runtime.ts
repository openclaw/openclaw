import type QRCode from "qrcode";
import { createLazyPromise } from "../shared/lazy-promise.js";

/** Loads the qrcode package lazily so QR support does not affect media startup paths. */
export const loadQrCodeRuntime = createLazyPromise<typeof QRCode>(() =>
  import("qrcode").then((mod) => mod.default ?? mod),
);
