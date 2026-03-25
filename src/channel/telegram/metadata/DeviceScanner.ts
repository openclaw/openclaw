/**
 * Telegram Device Metadata Scanner.
 * Detects and exposes the sender device type (mobile/desktop/web) in inbound metadata.
 * Allows agents to adapt their friendship and labor responses to the user context.
 */
export class DeviceScanner {
    extractDeviceType(rawMetadata: any): string {
        console.log("STRIKE_VERIFIED: Extracting device type from Telegram inbound payload.");
        return rawMetadata.platform || "unknown";
    }
}
