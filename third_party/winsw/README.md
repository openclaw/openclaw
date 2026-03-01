# WinSW - Windows Service Wrapper

本目录包含 WinSW（Windows Service Wrapper），用于将 OpenClaw Gateway 注册为 Windows 原生服务。

## 许可证

MIT License - 详见 LICENSE 文件

## 版本

v2.12.0（稳定版）

## 文件说明

- `WinSW-x64.exe` - Windows x64 二进制（从 GitHub Release 下载）
- `openclaw-gateway.xml` - 服务配置文件模板
- `LICENSE` - MIT 许可证副本
- `SHA256.txt` - 二进制校验文件

## 下载命令

```powershell
# 下载 WinSW v2.12.0
curl -L -o WinSW-x64.exe https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe

# 验证 SHA256
sha256sum WinSW-x64.exe
```

## 使用方式

详见 `src/daemon/winsw.ts` 中的实现。

## 第三方依赖

- **WinSW**: https://github.com/winsw/winsw
- **许可证**: MIT
- **维护者**: WinSW Team
