# OpenClaw UI 模块流程文档

## 概述

UI 模块是 OpenClaw 的前端界面模块，基于 Web 技术构建，负责用户交互和界面展示。

## 1. UI 模块结构

```
ui/
├── index.html          # HTML 入口
├── package.json        # 包配置
├── vite.config.ts      # Vite 配置
├── public/            # 静态资源
├── src/
│   ├── main.ts         # 主入口
│   ├── styles/         # 样式文件
│   ├── i18n/          # 国际化
│   ├── types/          # 类型定义
│   └── ui/             # UI 组件
│       ├── app.ts      # 应用主组件
│       ├── app-chat.ts # 聊天界面
│       ├── app-settings.ts # 设置界面
│       ├── chat/       # 聊天组件
│       ├── components/ # UI 组件
│       ├── controllers/# 控制器
│       └── views/      # 视图
```

## 2. 应用启动流程

### 2.1 启动时序图

```mermaid
sequenceDiagram
    participant Main as main.ts
    participant App as app.ts
    participant Lifecycle as app-lifecycle.ts
    participant Gateway as app-gateway.ts
    participant Chat as app-chat.ts

    Main->>App: createApp()
    App->>Lifecycle: initLifecycle()
    Lifecycle->>Gateway: connectGateway()
    Gateway-->>App: gateway connected
    App->>Chat: initializeChat()
    Chat-->>App: chat ready
    App-->>User: UI rendered
```

## 3. 主要界面组件

### 3.1 聊天界面流程 (app-chat.ts)

```mermaid
graph TD
    A["用户打开聊天界面"] --> B["app-chat.ts 初始化"]
    B --> C["加载历史消息"]
    C --> D["连接 Gateway WebSocket"]
    D --> E["监听新消息"]
    E --> F{"收到消息?"}
    F -->|"是"| G["渲染消息到 UI"]
    F -->|"否"| H["等待用户输入"]
    G --> H
    H --> I["用户发送消息"]
    I --> J["发送到 Gateway"]
    J --> K{"等待响应?"}
    K -->|"流式响应"| L["流式渲染"]
    K -->|"完整响应"| M["一次性渲染"]
    L --> N["响应完成"]
    M --> N
```

### 3.2 消息渲染流程

```mermaid
graph LR
    A["消息数据"] --> B["app-render.ts"]
    B --> C{"消息类型"}
    C -->|"文本"| D["Markdown 渲染"]
    C -->|"工具"| E["工具结果卡片"]
    C -->|"图片"| F["图片预览"]
    C -->|"语音"| G["音频播放器"]
    D --> H["DOM 更新"]
    E --> H
    F --> H
    G --> H
```

## 4. 控制器架构

### 4.1 控制器列表

| 控制器 | 功能 |
|-------|------|
| `ChatModelRefController` | 模型选择管理 |
| `ChatScrollController` | 滚动位置管理 |
| `RealtimeTalkController` | 实时语音对话 |
| `ToolStreamController` | 工具流处理 |
| `SettingsRefreshController` | 设置刷新 |

### 4.2 控制器流程

```mermaid
graph TD
    A["用户操作"] --> B["Controller 捕获事件"]
    B --> C["更新 State"]
    C --> D{"State 变化?"}
    D -->|"是"| E["触发 UI 重新渲染"]
    D -->|"否"| F["忽略"]
    E --> G["更新视图"]
```

## 5. Gateway 连接流程

### 5.1 WebSocket 连接时序

```mermaid
sequenceDiagram
    participant UI as UI Layer
    participant GW as Gateway Client
    participant WS as WebSocket
    participant Server as Gateway Server

    UI->>GW: createGatewaySession()
    GW->>Server: Connect + Auth
    Server-->>GW: Auth Success
    WS-->>GW: Connection Established
    GW-->>UI: session ready
    UI->>GW: sendMessage()
    GW->>WS: WebSocket Frame
    WS->>Server: Route Message
    Server-->>WS: Response
    WS-->>GW: Response Frame
    GW-->>UI: onMessage()
```

## 6. 应用状态管理

### 6.1 状态架构

```mermaid
graph TD
    A["AppState"] --> B["GatewayState"]
    A --> C["ChatState"]
    A --> D["SettingsState"]
    A --> E["NavigationState"]
    
    B --> B1["connectionStatus"]
    B --> B2["sessionId"]
    B --> B3["authToken"]
    
    C --> C1["messages"]
    C --> C2["currentModel"]
    C --> C3["streamingState"]
    
    D --> D1["theme"]
    D --> D2["language"]
    D --> D3["pluginConfig"]
    
    E --> E1["currentView"]
    E --> E2["sidebarOpen"]
```

## 7. 关键文件

| 文件路径 | 职责 |
|---------|------|
| `ui/src/main.ts` | 应用入口点 |
| `ui/src/ui/app.ts` | 应用主组件 |
| `ui/src/ui/app-chat.ts` | 聊天界面 |
| `ui/src/ui/app-settings.ts` | 设置界面 |
| `ui/src/ui/gateway.ts` | Gateway 客户端封装 |
| `ui/src/ui/app-lifecycle.ts` | 应用生命周期 |
| `ui/src/ui/storage.ts` | 本地存储管理 |
| `ui/src/ui/theme.ts` | 主题管理 |

## 8. Vite 配置

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    port: 3000,  // 开发服务器端口
    proxy: {
      // API 请求代理到 Gateway
      "/api": {
        target: "http://localhost:18789",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",  // 输出目录
    sourcemap: true,  // 生成 sourcemap
  },
});
```
