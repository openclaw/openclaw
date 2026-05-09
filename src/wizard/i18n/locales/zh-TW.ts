import type { LocaleMap } from "../types.js";

export const zhTW: LocaleMap = {
  // ===== setup.ts =====
  "OpenClaw setup": "OpenClaw 瑷畾",
  "Setup mode": "瑷畾妯″紡",
  "QuickStart": "蹇€熼枊濮?,
  "Manual": "鎵嬪嫊瑷畾",
  "Configure details later via openclaw configure.": "寰岀簩鍙€忛亷 openclaw configure 鍛戒护瑷畾瑭虫儏銆?,
  "Configure port, network, Tailscale, and auth options.": "瑷畾閫ｆ帴鍩犮€佺恫璺€乀ailscale 鍜岄璀夐伕闋呫€?,
  "Config handling": "瑷畾妾旇檿鐞?,
  "Use existing values": "浣跨敤鐝炬湁瑷畾",
  "Update values": "鏇存柊瑷畾",
  "Reset": "閲嶇疆",
  "Config only": "鍍呴噸缃ō瀹?,
  "Config + creds + sessions": "閲嶇疆瑷畾 + 鎲戣瓑 + 宸ヤ綔闅庢",
  "Full reset (config + creds + sessions + workspace)": "瀹屽叏閲嶇疆锛堣ō瀹?+ 鎲戣瓑 + 宸ヤ綔闅庢 + 宸ヤ綔鍗€锛?,
  "Reset scope": "閲嶇疆绡勫湇",
  "Workspace directory": "宸ヤ綔鍗€鐩寗",
  "What do you want to set up?": "鎮ㄦ兂瑷畾浠€楹硷紵",
  "Local gateway (this machine)": "鏈湴缍查棞锛堟湰姗燂級",
  "Remote gateway (info-only)": "閬犵缍查棞锛堝儏鏌ョ湅锛?,

  // ===== setup.finalize.ts =====
  "Install Gateway service (recommended)": "瀹夎 Gateway 鏈嶅嫏锛堝缓璀帮級",
  "Gateway service runtime": "Gateway 鏈嶅嫏鍩疯鐠板",
  "Gateway service already installed": "Gateway 鏈嶅嫏宸插畨瑁?,
  "Restart": "閲嶆柊鍟熷嫊",
  "Reinstall": "閲嶆柊瀹夎",
  "Skip": "鐣ラ亷",
  "Gateway service uninstalled.": "Gateway 鏈嶅嫏宸茶В闄ゅ畨瑁濄€?,
  "How do you want to hatch your bot?": "鎮ㄦ兂濡備綍鍟熷嫊鎮ㄧ殑姗熷櫒浜猴紵",
  "Open the Web UI": "闁嬪暉 Web 鎺у埗鍙?,
  "Hatch in Terminal (recommended)": "鍦ㄧ祩绔涓暉鍕曪紙寤鸿锛?,
  "Do this later": "绋嶅緦鍐嶅仛",

  // ===== setup.gateway-config.ts =====
  "Gateway auth": "Gateway 椹楄瓑",
  "Token": "娆婃潠",
  "Password": "瀵嗙⒓",
  "Recommended default (local + remote)": "寤鸿闋愯ō锛堟湰鍦?+ 閬犵锛?,
  "Generate/store plaintext token": "鐢㈢敓/鍎插瓨鏄庢枃娆婃潠",
  "Default": "闋愯ō",
  "Use SecretRef": "浣跨敤 SecretRef",
  "Store a reference instead of plaintext": "鍎插瓨寮曠敤鑰岄潪鏄庢枃",
  "Needed for multi-machine or non-loopback access": "澶氭鎴栭潪鍥為€佸瓨鍙栨檪闇€瑕?,
  "Where is this gateway token stored?": "姝ょ恫闂滄瑠鏉栧劜瀛樺湪鍝！锛?,
  "Where is this gateway password stored?": "姝ょ恫闂滃瘑纰煎劜瀛樺湪鍝！锛?,
  "Enter password now": "绔嬪嵆杓稿叆瀵嗙⒓",
  "Stores the password directly in OpenClaw config": "灏囧瘑纰肩洿鎺ュ劜瀛樺湪 OpenClaw 瑷畾涓?,
  "Gateway bind": "Gateway 绻祼浣嶅潃",
  "Gateway port": "Gateway 閫ｆ帴鍩?,
  "Gateway password": "Gateway 瀵嗙⒓",
  "How do you want to provide the gateway token?": "濡備綍鎻愪緵缍查棞娆婃潠锛?,
  "How do you want to provide the gateway password?": "濡備綍鎻愪緵缍查棞瀵嗙⒓锛?,
  "Gateway token (blank to generate)": "Gateway 娆婃潠锛堢暀绌鸿嚜鍕曠敘鐢燂級",
  "Loopback (127.0.0.1)": "鍥為€佷綅鍧€锛?27.0.0.1锛?,
  "LAN (0.0.0.0)": "鍗€鍩熺恫璺紙0.0.0.0锛?,
  "Tailnet (Tailscale IP)": "Tailnet锛圱ailscale IP锛?,
  "Custom IP": "鑷▊ IP",
  "Custom IP address": "鑷▊ IP 浣嶅潃",
  "Auto (Loopback 鈫?LAN)": "鑷嫊锛堝洖閫?鈫?鍗€鍩熺恫璺級",
  "Tailscale exposure": "Tailscale 灏嶅鍏枊",
  "Reset Tailscale serve/funnel on exit?": "绲愭潫鏅傞噸缃?Tailscale 鏈嶅嫏/閫氶亾锛?,

  // ===== setup.official-plugins.ts =====
  "Install optional plugins": "瀹夎閬哥敤鎻掍欢",
  "Skip for now": "鏆檪鐣ラ亷",
  "Continue without installing optional plugins": "绻肩簩鑰屼笉瀹夎閬哥敤鎻掍欢",

  // ===== setup.plugin-config.ts =====
  "Configure plugins (select to set up now, or skip)": "瑷畾鎻掍欢锛堥伕鎿囩珛鍗宠ō瀹氾紝鎴栫暐閬庯級",
  "Select plugin to configure": "閬告搰瑕佽ō瀹氱殑鎻掍欢",
  "Continue without configuring plugins": "绻肩簩鑰屼笉瑷畾鎻掍欢",
  "Back": "杩斿洖",
  "Return to section menu": "杩斿洖閬稿柈",

  // ===== setup.migration-import.ts =====
  "Migration source": "閬风Щ渚嗘簮",
  "Enter a source path next": "鎺ヤ笅渚嗚几鍏ヤ締婧愯矾寰?,
  "Source agent home": "渚嗘簮 Agent 鐩寗",
  "Target workspace directory": "鐩宸ヤ綔鍗€鐩寗",
  "Apply this migration now?": "绔嬪嵆鍩疯姝ら伔绉伙紵",

  // ===== onboard-remote.ts =====
  "Connection method": "閫ｇ窔鏂瑰紡",
  "How do you want to provide this gateway token?": "濡備綍鎻愪緵姝ょ恫闂滄瑠鏉栵紵",
  "Enter token now": "绔嬪嵆杓稿叆娆婃潠",
  "Stores the token directly in OpenClaw config": "灏囨瑠鏉栫洿鎺ュ劜瀛樺湪 OpenClaw 瑷畾涓?,
  "Discover gateway on LAN (Bonjour)?": "鍦ㄥ崁鍩熺恫璺腑鎺㈢储 Gateway锛圔onjour锛夛紵",
  "Select gateway": "閬告搰 Gateway",
  "Enter URL manually": "鎵嬪嫊杓稿叆 URL",
  "Gateway WebSocket URL": "Gateway WebSocket 浣嶅潃",
  "SSH tunnel (loopback)": "SSH 閫氶亾锛堝洖閫侊級",
  "No auth": "鐒￠渶椹楄瓑",
  "Token (recommended)": "娆婃潠锛堝缓璀帮級",

  // ===== onboard-custom.ts =====
  "OpenAI-compatible": "鐩稿 OpenAI",
  "Uses /chat/completions": "浣跨敤 /chat/completions",
  "Uses /messages": "浣跨敤 /messages",
  "Probes OpenAI then Anthropic endpoints": "鍏堟帰娓?OpenAI 鍐?Anthropic 绔粸",
  "API Key (leave blank if not required)": "API 閲戦懓锛堝涓嶉渶瑕佽珛鐣欑┖锛?,
  "Anthropic-compatible": "鐩稿 Anthropic",
  "Unknown (detect automatically)": "鏈煡锛堣嚜鍕曞伒娓級",
  "Endpoint compatibility": "浠嬮潰鐩稿鎬?,
  "API Base URL": "API 鍩虹浣嶅潃",
  "Change base URL": "淇敼鍩虹浣嶅潃",
  "Change model": "淇敼妯″瀷",
  "Change base URL and model": "淇敼鍩虹浣嶅潃鍜屾ā鍨?,
  "What would you like to change?": "鎮ㄦ兂淇敼浠€楹硷紵",
  "Model ID": "妯″瀷 ID",
  "Model alias (optional)": "妯″瀷鍒ュ悕锛堥伕鐢級",
  "Endpoint ID": "浠嬮潰 ID",
  "Does this model support image input?": "姝ゆā鍨嬫敮鎻村湒鐗囪几鍏ュ棊锛?,

  // ===== channel-setup.ts (flows) =====
  "Select a channel": "閬告搰闋婚亾",
  "Select channel (QuickStart)": "閬告搰闋婚亾锛堝揩閫熼枊濮嬶級",
  "Finished": "瀹屾垚",
  "Configure chat channels now?": "绔嬪嵆瑷畾鑱婂ぉ闋婚亾锛?,

  // ===== onboard-search.ts =====
  // "Keep default" 鈥?not a user-facing prompt string in the source

  // ===== onboard-hooks.ts =====
  "Enable hooks?": "鍟熺敤閴ゅ瓙锛?,

  // ===== onboard-skills.ts =====
  "Configure skills now? (recommended)": "绔嬪嵆瑷畾鎶€鑳斤紵锛堝缓璀帮級",
  "Install missing skill dependencies": "瀹夎缂哄皯鐨勬妧鑳界浉渚濆浠?,
  "Show Homebrew install command?": "椤ず Homebrew 瀹夎鍛戒护锛?,
  "Preferred node manager for skill installs": "鎶€鑳藉畨瑁濈殑鎱ｇ敤濂椾欢绠＄悊鍣?,
  "Continue without installing dependencies": "绻肩簩鑰屼笉瀹夎渚濊炒",
};
