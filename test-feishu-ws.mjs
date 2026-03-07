import { createClient } from "@larksuiteoapi/node-sdk";
import fs from "fs";
import path from "path";

async function main() {
    const cfgPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));

    const feishuCfg = cfg.channels?.feishu;
    if (!feishuCfg) throw new Error("No feishu config");

    const account = feishuCfg.accounts?.[0];
    if (!account) throw new Error("No feishu account");

    console.log(`Using App ID: ${account.appId}`);

    // We can't easily start a full websocket client without rewriting part of SDK wiring, 
    // but we can just ask the user to double check Developer Console
}

main().catch(console.error);
