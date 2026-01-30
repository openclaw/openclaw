import type { MoltbotConfig } from "../../../config/config.js";
// @ts-ignore
import * as process from "node:process";
// @ts-ignore
import * as buffer from "node:buffer";
const { Buffer } = buffer;

export class TwilioClient {
    private accountSid?: string;
    private authToken?: string;
    private fromNumber?: string;

    constructor(config: MoltbotConfig) {
        // Types need to be updated in schema.ts to support these fields strictly
        const twilioCfg = (config.channels as any)?.["twilio-messaging"];
        this.accountSid = twilioCfg?.accountSid || process.env.TWILIO_ACCOUNT_SID;
        this.authToken = twilioCfg?.authToken || process.env.TWILIO_AUTH_TOKEN;
        this.fromNumber = twilioCfg?.phoneNumber || process.env.TWILIO_PHONE_NUMBER;
    }

    async sendMessage(to: string, body: string, mediaUrl?: string): Promise<void> {
        if (!this.accountSid || !this.authToken || !this.fromNumber) {
            throw new Error("Twilio credentials not configured");
        }

        const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
        const params = new URLSearchParams();
        params.append("To", to);
        params.append("From", this.fromNumber);
        if (body) params.append("Body", body);
        if (mediaUrl) params.append("MediaUrl", mediaUrl);

        const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Twilio API Error: ${response.status} ${response.statusText} - ${errorText}`);
        }
    }
}
