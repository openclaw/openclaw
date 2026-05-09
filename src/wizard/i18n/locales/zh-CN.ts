import type { LocaleMap } from "../types.js";

export const zhCN: LocaleMap = {
  // ===== setup.ts =====
  "OpenClaw setup": "OpenClaw 璁剧疆",
  "Setup mode": "璁剧疆妯″紡",
  "QuickStart": "蹇€熷紑濮?,
  "Manual": "鎵嬪姩閰嶇疆",
  "Configure details later via openclaw configure.": "鍚庣画鍙€氳繃 openclaw configure 鍛戒护閰嶇疆璇︽儏銆?,
  "Configure port, network, Tailscale, and auth options.": "閰嶇疆绔彛銆佺綉缁溿€乀ailscale 鍜岃璇侀€夐」銆?,
  "Config handling": "閰嶇疆鏂囦欢澶勭悊",
  "Use existing values": "浣跨敤鐜版湁閰嶇疆",
  "Update values": "鏇存柊閰嶇疆",
  "Reset": "閲嶇疆",
  "Config only": "浠呴噸缃厤缃?,
  "Config + creds + sessions": "閲嶇疆閰嶇疆 + 鍑嵁 + 浼氳瘽",
  "Full reset (config + creds + sessions + workspace)": "瀹屽叏閲嶇疆锛堥厤缃?+ 鍑嵁 + 浼氳瘽 + 宸ヤ綔鍖猴級",
  "Reset scope": "閲嶇疆鑼冨洿",
  "Workspace directory": "宸ヤ綔鍖虹洰褰?,
  "What do you want to set up?": "鎮ㄦ兂璁剧疆浠€涔堬紵",
  "Local gateway (this machine)": "鏈湴缃戝叧锛堟湰鏈猴級",
  "Remote gateway (info-only)": "杩滅▼缃戝叧锛堜粎鏌ョ湅锛?,

  // ===== setup.finalize.ts =====
  "Install Gateway service (recommended)": "瀹夎 Gateway 鏈嶅姟锛堟帹鑽愶級",
  "Gateway service runtime": "Gateway 鏈嶅姟杩愯鏃?,
  "Gateway service already installed": "Gateway 鏈嶅姟宸插畨瑁?,
  "Restart": "閲嶅惎",
  "Reinstall": "閲嶆柊瀹夎",
  "Skip": "璺宠繃",
  "Gateway service uninstalled.": "Gateway 鏈嶅姟宸插嵏杞姐€?,
  "How do you want to hatch your bot?": "鎮ㄦ兂濡備綍鍚姩鎮ㄧ殑鏈哄櫒浜猴紵",
  "Open the Web UI": "鎵撳紑 Web 鎺у埗闈㈡澘",
  "Hatch in Terminal (recommended)": "鍦ㄧ粓绔腑鍚姩锛堟帹鑽愶級",
  "Do this later": "绋嶅悗鍐嶅仛",

  // ===== setup.gateway-config.ts =====
  "Gateway auth": "Gateway 璁よ瘉",
  "Token": "浠ょ墝",
  "Password": "瀵嗙爜",
  "Recommended default (local + remote)": "鎺ㄨ崘榛樿锛堟湰鍦?+ 杩滅▼锛?,
  "Generate/store plaintext token": "鐢熸垚/瀛樺偍鏄庢枃浠ょ墝",
  "Default": "榛樿",
  "Use SecretRef": "浣跨敤 SecretRef",
  "Store a reference instead of plaintext": "瀛樺偍寮曠敤鑰岄潪鏄庢枃",
  "Needed for multi-machine or non-loopback access": "澶氭満鎴栭潪鍥炵幆璁块棶鏃堕渶瑕?,
  "Where is this gateway token stored?": "杩欎釜缃戝叧浠ょ墝瀛樺偍鍦ㄥ摢閲岋紵",
  "Where is this gateway password stored?": "杩欎釜缃戝叧瀵嗙爜瀛樺偍鍦ㄥ摢閲岋紵",
  "Enter password now": "绔嬪嵆杈撳叆瀵嗙爜",
  "Stores the password directly in OpenClaw config": "灏嗗瘑鐮佺洿鎺ュ瓨鍌ㄥ湪 OpenClaw 閰嶇疆涓?,
  "Gateway bind": "Gateway 缁戝畾鍦板潃",
  "Gateway port": "Gateway 绔彛",
  "Gateway password": "Gateway 瀵嗙爜",
  "How do you want to provide the gateway token?": "濡備綍鎻愪緵缃戝叧浠ょ墝锛?,
  "How do you want to provide the gateway password?": "濡備綍鎻愪緵缃戝叧瀵嗙爜锛?,
  "Gateway token (blank to generate)": "Gateway 浠ょ墝锛堢暀绌鸿嚜鍔ㄧ敓鎴愶級",
  "Loopback (127.0.0.1)": "鍥炵幆鍦板潃锛?27.0.0.1锛?,
  "LAN (0.0.0.0)": "灞€鍩熺綉锛?.0.0.0锛?,
  "Tailnet (Tailscale IP)": "Tailnet锛圱ailscale IP锛?,
  "Custom IP": "鑷畾涔?IP",
  "Custom IP address": "鑷畾涔?IP 鍦板潃",
  "Auto (Loopback 鈫?LAN)": "鑷姩锛堝洖鐜?鈫?灞€鍩熺綉锛?,
  "Tailscale exposure": "Tailscale 瀵瑰鏆撮湶",
  "Reset Tailscale serve/funnel on exit?": "閫€鍑烘椂閲嶇疆 Tailscale 鏈嶅姟/闅ч亾锛?,

  // ===== setup.official-plugins.ts =====
  "Install optional plugins": "瀹夎鍙€夋彃浠?,
  "Skip for now": "鏆傛椂璺宠繃",
  "Continue without installing optional plugins": "缁х画鑰屼笉瀹夎鍙€夋彃浠?,

  // ===== setup.plugin-config.ts =====
  "Configure plugins (select to set up now, or skip)": "閰嶇疆鎻掍欢锛堥€夋嫨绔嬪嵆璁剧疆锛屾垨璺宠繃锛?,
  "Select plugin to configure": "閫夋嫨瑕侀厤缃殑鎻掍欢",
  "Continue without configuring plugins": "缁х画鑰屼笉閰嶇疆鎻掍欢",
  "Back": "杩斿洖",
  "Return to section menu": "杩斿洖鑿滃崟",

  // ===== setup.migration-import.ts =====
  "Migration source": "杩佺Щ鏉ユ簮",
  "Enter a source path next": "鎺ヤ笅鏉ヨ緭鍏ユ潵婧愯矾寰?,
  "Source agent home": "鏉ユ簮 Agent 鐩綍",
  "Target workspace directory": "鐩爣宸ヤ綔鍖虹洰褰?,
  "Apply this migration now?": "绔嬪嵆鎵ц姝よ縼绉伙紵",

  // ===== setup.security-note.ts (strings used in setup.ts) =====
  // Security note strings are imported as constants, need separate handling

  // ===== onboard-remote.ts =====
  "Connection method": "杩炴帴鏂瑰紡",
  "How do you want to provide this gateway token?": "濡備綍鎻愪緵姝ょ綉鍏充护鐗岋紵",
  "Enter token now": "绔嬪嵆杈撳叆浠ょ墝",
  "Stores the token directly in OpenClaw config": "灏嗕护鐗岀洿鎺ュ瓨鍌ㄥ湪 OpenClaw 閰嶇疆涓?,
  "Discover gateway on LAN (Bonjour)?": "鍦ㄥ眬鍩熺綉涓彂鐜?Gateway锛圔onjour锛夛紵",
  "Select gateway": "閫夋嫨 Gateway",
  "Enter URL manually": "鎵嬪姩杈撳叆 URL",
  "Gateway WebSocket URL": "Gateway WebSocket 鍦板潃",
  "SSH tunnel (loopback)": "SSH 闅ч亾锛堝洖鐜級",
  "No auth": "鏃犻渶璁よ瘉",
  "Token (recommended)": "浠ょ墝锛堟帹鑽愶級",

  // ===== onboard-custom.ts =====
  "OpenAI-compatible": "鍏煎 OpenAI",
  "Uses /chat/completions": "浣跨敤 /chat/completions",
  "Uses /messages": "浣跨敤 /messages",
  "Probes OpenAI then Anthropic endpoints": "鍏堟帰娴?OpenAI 鍐?Anthropic 绔偣",
  "API Key (leave blank if not required)": "API 瀵嗛挜锛堝涓嶉渶瑕佽鐣欑┖锛?,
  "Anthropic-compatible": "鍏煎 Anthropic",
  "Unknown (detect automatically)": "鏈煡锛堣嚜鍔ㄦ娴嬶級",
  "Endpoint compatibility": "鎺ュ彛鍏煎鎬?,
  "API Base URL": "API 鍩虹鍦板潃",
  "Change base URL": "淇敼鍩虹鍦板潃",
  "Change model": "淇敼妯″瀷",
  "Change base URL and model": "淇敼鍩虹鍦板潃鍜屾ā鍨?,
  "What would you like to change?": "鎮ㄦ兂淇敼浠€涔堬紵",
  "Model ID": "妯″瀷 ID",
  "Model alias (optional)": "妯″瀷鍒悕锛堝彲閫夛級",
  "Endpoint ID": "鎺ュ彛 ID",
  "Does this model support image input?": "姝ゆā鍨嬫敮鎸佸浘鐗囪緭鍏ュ悧锛?,

  // ===== channel-setup.ts (flows) =====
  "Select a channel": "閫夋嫨棰戦亾",
  "Select channel (QuickStart)": "閫夋嫨棰戦亾锛堝揩閫熷紑濮嬶級",
  "Finished": "瀹屾垚",
  "Configure chat channels now?": "绔嬪嵆閰嶇疆鑱婂ぉ棰戦亾锛?,

  // ===== onboard-search.ts =====
  // "Keep default" 鈥?not a user-facing prompt string in the source

  // ===== onboard-hooks.ts =====
  "Enable hooks?": "鍚敤閽╁瓙锛?,

  // ===== onboard-skills.ts =====
  "Configure skills now? (recommended)": "绔嬪嵆閰嶇疆鎶€鑳斤紵锛堟帹鑽愶級",
  "Install missing skill dependencies": "瀹夎缂哄け鐨勬妧鑳戒緷璧?,
  "Show Homebrew install command?": "鏄剧ず Homebrew 瀹夎鍛戒护锛?,
  "Preferred node manager for skill installs": "鎶€鑳藉畨瑁呯殑棣栭€夊寘绠＄悊鍣?,
  "Continue without installing dependencies": "缁х画鑰屼笉瀹夎渚濊禆",
};
