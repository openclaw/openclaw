---（轉為繁體中文）
name: boot-md（轉為繁體中文）
description: "Run BOOT.md on gateway startup"（轉為繁體中文）
homepage: https://docs.openclaw.ai/hooks#boot-md（轉為繁體中文）
metadata:（轉為繁體中文）
  {（轉為繁體中文）
    "openclaw":（轉為繁體中文）
      {（轉為繁體中文）
        "emoji": "🚀",（轉為繁體中文）
        "events": ["gateway:startup"],（轉為繁體中文）
        "requires": { "config": ["workspace.dir"] },（轉為繁體中文）
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],（轉為繁體中文）
      },（轉為繁體中文）
  }（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
# Boot Checklist Hook（轉為繁體中文）
（轉為繁體中文）
Runs `BOOT.md` every time the gateway starts, if the file exists in the workspace.（轉為繁體中文）
