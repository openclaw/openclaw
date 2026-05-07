import type { LocaleMap } from "./types.js";

export const zhTW: LocaleMap = {
  // ===== setup.ts =====
  "OpenClaw setup": "OpenClaw 設定",
  "Setup mode": "設定模式",
  "QuickStart": "快速開始",
  "Manual": "手動設定",
  "Configure details later via openclaw configure.": "後續可透過 openclaw configure 指令設定細節。",
  "Configure port, network, Tailscale, and auth options.": "設定連接埠、網路、Tailscale 和認證選項。",
  "Config handling": "設定檔處理",
  "Use existing values": "使用現有設定",
  "Update values": "更新設定",
  "Reset": "重設",
  "Config only": "僅重設設定",
  "Config + creds + sessions": "重設設定 + 憑證 + 對話",
  "Full reset (config + creds + sessions + workspace)": "完全重設（設定 + 憑證 + 對話 + 工作區）",
  "Reset scope": "重設範圍",
  "Workspace directory": "工作區目錄",
  "What do you want to set up?": "您想設定什麼？",
  "Local gateway (this machine)": "本機閘道（此電腦）",
  "Remote gateway (info-only)": "遠端閘道（僅檢視）",

  // ===== setup.finalize.ts =====
  "Install Gateway service (recommended)": "安裝 Gateway 服務（建議）",
  "Gateway service runtime": "Gateway 服務執行環境",
  "Gateway service already installed": "Gateway 服務已安裝",
  "Restart": "重新啟動",
  "Reinstall": "重新安裝",
  "Skip": "跳過",
  "Gateway service uninstalled.": "Gateway 服務已解除安裝。",
  "How do you want to hatch your bot?": "您想如何啟動您的機器人？",
  "Open the Web UI": "開啟 Web 控制面板",
  "Hatch in Terminal (recommended)": "在終端機中啟動（建議）",
  "Do this later": "稍後再處理",

  // ===== setup.gateway-config.ts =====
  "Gateway auth": "Gateway 認證",
  "Gateway bind": "Gateway 繫結位址",
  "Gateway port": "Gateway 連接埠",
  "Gateway password": "Gateway 密碼",
  "Gateway token (blank to generate)": "Gateway 令牌（留空自動產生）",
  "Loopback (127.0.0.1)": "迴環位址（127.0.0.1）",
  "LAN (0.0.0.0)": "區域網路（0.0.0.0）",
  "Tailnet (Tailscale IP)": "Tailnet（Tailscale IP）",
  "Custom IP": "自訂 IP",
  "Custom IP address": "自訂 IP 位址",
  "Auto (Loopback → LAN)": "自動（迴環 → 區域網路）",
  "Tailscale exposure": "Tailscale 對外暴露",
  "Reset Tailscale serve/funnel on exit?": "退出時重設 Tailscale 服務/隧道？",
  "How do you want to provide the gateway token?": "您要如何提供 Gateway 令牌？",
  "How do you want to provide the gateway password?": "您要如何提供 Gateway 密碼？",
  "Where is this gateway token stored?": "此 Gateway 令牌儲存在哪裡？",
  "Where is this gateway password stored?": "此 Gateway 密碼儲存在哪裡？",
  "Generate/store plaintext token": "產生/儲存明文令牌",
  "Use SecretRef": "使用 SecretRef",
  "Enter password now": "立即輸入密碼",
  "Token": "令牌",
  "Password": "密碼",
  "Use existing gateway token": "使用現有 Gateway 令牌",

  // ===== setup.official-plugins.ts =====
  "Install optional plugins": "安裝選用外掛",
  "Skip for now": "暫時跳過",

  // ===== setup.plugin-config.ts =====
  "Configure plugins (select to set up now, or skip)": "設定外掛（選擇立即設定，或跳過）",
  "Select plugin to configure": "選擇要設定的外掛",
  "Back": "返回",
  "Return to section menu": "返回章節選單",

  // ===== setup.migration-import.ts =====
  "Migration source": "移轉來源",
  "Source agent home": "來源 Agent 目錄",
  "Target workspace directory": "目標工作區目錄",
  "Apply this migration now?": "立即執行此移轉？",

  // ===== Additional translations =====
  "Token": "令牌",
  "Password": "密碼",
  "Back": "返回",
  "Return to section menu": "返回章節選單",
};
