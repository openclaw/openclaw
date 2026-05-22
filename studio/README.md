# ClaWorks Studio（轻量占位）

本目录 **不是** 已归档的 `clawtwin-studio`（Refine/Rust 旧 UI）。

| 文件         | 说明                                                        |
| ------------ | ----------------------------------------------------------- |
| `index.html` | 单机静态页：本地调试 REST / Pack / 连接器状态（无构建步骤） |

打开方式：

```bash
pnpm claworks:gateway   # 默认 :18800
open studio/index.html  # 或经 Gateway 静态路由（若已配置）
```

完整 Studio 产品化见 `docs/design/IMPLEMENTATION-STATUS.md` 与 `packages/claworks-runtime/src/interfaces/studio/`。
