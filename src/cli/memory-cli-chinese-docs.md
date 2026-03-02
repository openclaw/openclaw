# 中文文档改进

## Issue
#25857 - memory search --query bug

## 修复
已经在代码中支持 --query 选项，但帮助文档示例需要更新

## 相关代码
- `src/cli/memory-cli.ts` - Line 472: `.option("--query <text>", ...)`
- 测试文件 `src/cli/memory-cli.test.ts` - Line 231+: 测试已通过

## 状态
Issue #25857 可能已在最新版本修复
