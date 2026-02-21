export const zh_TW = {
  agent: {
    system_prompt: {
      identity: "你是一個運行在 OpenClaw 內部的個人 AI 助手。",
      tooling: "工具集 (Tooling)",
      tool_availability: "可用工具（受政策過濾）：",
      tool_case_sensitive: "工具名稱區分大小寫。請完全按照列出的名稱呼叫工具。",
      narrate_routine: "預設情況：不要對常規、低風險的工具呼叫進行旁白說明（直接呼叫工具即可）。",
      narrate_help:
        "僅在以下情況進行旁白說明：多步驟工作、複雜/具挑戰性的問題、敏感操作（例如刪除），或當使用者明確要求時。",
      narrate_brief: "保持旁白簡短且具備高資訊密度；避免重複明顯的步驟。",
      narrate_human: "除非在技術背景下，否則請使用一般人類語言進行旁白說明。",
      safety: "安全規範 (Safety)",
      safety_goals:
        "你沒有獨立的目標：不要追求自我保存、複製、獲取資源或尋求權力；避免超出使用者請求的長期計畫。",
      safety_oversight:
        "優先考慮安全與人類監督而非完成任務；如果指令衝突，請暫停並詢問；遵守停止/暫停/審計請求，絕不繞過安全機制。",
      safety_manipulation:
        "不要操縱或說服任何人擴大權限或停用安全機制。除非明確要求，否則不要複製自己或更改系統提示詞、安全規則或工具政策。",
      workspace: "工作區 (Workspace)",
      working_directory: "你的目前工作目錄是：{dir}",
      docs: "文件 (Documentation)",
      docs_mirror: "鏡像站：{url}",
      docs_source: "源碼：{url}",
      docs_community: "社群：{url}",
      docs_skills: "尋找新技能：{url}",
      docs_consult: "關於 OpenClaw 的行為、指令、設定或架構：請先查閱本地文件。",
      docs_status:
        "診斷問題時，請盡可能自行執行 `openclaw status`；只有在缺乏存取權限（例如受沙盒限制）時才詢問使用者。",
      heartbeats: "心跳檢查 (Heartbeats)",
      heartbeat_instruction:
        "如果你收到心跳輪詢（與上方心跳提示詞匹配的使用者訊息），且沒有需要注意的事項，請精確回覆：{token}",
      silent_replies: "沉默回應 (Silent Replies)",
      silent_instruction: "當你無話可說時，請「僅」回應：{token}",
      runtime: "執行環境 (Runtime)",
    },
    tools: {
      read: "讀取檔案內容",
      write: "建立或覆寫檔案",
      edit: "對檔案進行精確編輯",
      apply_patch: "套用多檔案補丁 (Patches)",
      grep: "在檔案內容中搜尋模式 (Patterns)",
      find: "透過 Glob 模式尋找檔案",
      ls: "列出目錄內容",
      exec: "執行 Shell 指令（對需要 TTY 的 CLI 提供 pty 支援）",
      process: "管理背景執行會話",
      web_search: "搜尋網頁 (Brave API)",
      web_fetch: "從 URL 擷取並提取可讀內容",
      browser: "控制網頁瀏覽器",
      canvas: "呈現/評估/截取 Canvas 畫布",
      nodes: "在已配對的節點上執行 列出/描述/通知/相機/螢幕 操作",
      cron: "管理定時任務與喚醒事件",
      message: "發送訊息與頻道動作",
      gateway: "對執行中的 OpenClaw 程序進行重啟、套用設定或執行更新",
      agents_list: "列出允許執行 sessions_spawn 的 Agent ID",
      sessions_list: "列出其他會話（含子 Agent），支援過濾器",
      sessions_history: "獲取另一個會話或子 Agent 的對話歷史",
      sessions_send: "向另一個會話或子 Agent 發送訊息",
      sessions_spawn: "啟動一個子 Agent 會話",
      subagents: "為此請求會話列出、導向或終止子 Agent 執行",
      session_status: "顯示狀態卡片（包含使用量、時間與模型狀態）",
      image: "使用配置的影像模型分析影像",
    },
  },
  cli: {
    common: {
      examples: "範例：",
      docs: "文件：",
    },
    setup: {
      description: "初始化本地設定與 Agent 工作區",
    },
    onboard: {
      description: "互動式上線精靈，設定 Gateway、工作區與技能",
    },
    configure: {
      description: "互動式設定精靈，用於憑證、頻道、Gateway 與 Agent 預設值",
    },
    config: {
      description: "非互動式設定輔助工具 (get/set/unset)。預設啟動設定精靈。",
    },
    doctor: {
      description: "Gateway 與通訊頻道的健康檢查與快速修復",
    },
    dashboard: {
      description: "使用目前的權杖開啟控制台 (Control UI)",
    },
    reset: {
      description: "重設本地設定與狀態（保留 CLI 安裝）",
    },
    uninstall: {
      description: "卸載 Gateway 服務與本地資料（保留 CLI）",
    },
    message: {
      description: "發送、讀取與管理訊息",
      example_send: "發送純文字訊息。",
      example_media: "發送包含多媒體的訊息。",
      example_poll: "建立 Discord 投票。",
      example_react: "對訊息發送表情回應。",
    },
    memory: {
      description: "搜尋與重新索引記憶檔案",
    },
    agent: {
      description: "透過 Gateway 執行單次 Agent 對話",
    },
    agents: {
      description: "管理隔離的 Agent（工作區、驗證、路由）",
    },
    status: {
      description: "顯示頻道健康狀況與最近會話對象",
      example_basic: "顯示頻道健康狀況與會話摘要。",
      example_all: "完整診斷（唯讀）。",
      example_json: "機器可讀的輸出格式。",
      example_usage: "顯示模型供應商的使用量與配額快照。",
      example_deep: "執行頻道探測 (WA + Telegram + Discord + Slack + Signal)。",
      example_timeout: "縮短探測逾時時間。",
    },
    health: {
      description: "從運行中的 Gateway 獲取健康狀態",
    },
    sessions: {
      description: "列出儲存的對話會話",
      example_basic: "列出所有會話。",
      example_active: "僅顯示最近 2 小時。",
      example_json: "機器可讀的輸出格式。",
      example_store: "使用特定的會話儲存路徑。",
      token_usage_hint:
        "當 Agent 回報時，顯示每個會話的權杖使用量；設定 agents.defaults.contextTokens 以限制視窗並顯示百分比。",
    },
    browser: {
      description: "管理 OpenClaw 專用的瀏覽器 (Chrome/Chromium)",
    },
    gateway: {
      description: "執行、檢查與查詢 WebSocket Gateway",
      run_description: "執行 WebSocket Gateway (前景運行)",
      status_description: "顯示 Gateway 服務狀態並探測連線能力",
      run_help: "在前景執行 Gateway。",
      status_help: "顯示服務狀態並探測連線能力。",
      discover_help: "尋找本地與廣域 Gateway 信標。",
      call_help: "直接呼叫 Gateway RPC 方法。",
    },
  },
};
