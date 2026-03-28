# test-pr.ps1 - 测试 PR #41113

Write-Host "🧪 测试 PR #41113 (RFC2544 bypass with proxy detection)" -ForegroundColor Green

# 检查构建
if (-not (Test-Path "dist\index.js")) {
    Write-Host "❌ 需要先构建项目" -ForegroundColor Red
    Write-Host "运行: pnpm run build:docker" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ 构建文件存在" -ForegroundColor Green

# 停止当前 gateway
Write-Host "`n🛑 停止当前 gateway..." -ForegroundColor Yellow
$currentGateway = Get-Process -Id (Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -eq "node"}
if ($currentGateway) {
    Stop-Process -Id $currentGateway.Id -Force
    Write-Host "✅ 已停止" -ForegroundColor Green
} else {
    Write-Host "ℹ️  没有运行中的 gateway" -ForegroundColor Gray
}

# 使用本地版本启动
Write-Host "`n🚀 使用 PR 版本启动 gateway..." -ForegroundColor Cyan
Write-Host "提示: 这会使用当前目录的 openclaw 版本" -ForegroundColor Gray
Write-Host "`n请在新的 terminal 窗口中运行:" -ForegroundColor Yellow
Write-Host "  cd C:\Users\sunki\openclaw-pr" -ForegroundColor White
Write-Host "  .\node_modules\.bin\openclaw gateway start" -ForegroundColor White

Write-Host "`n或者直接运行:" -ForegroundColor Yellow
Write-Host "  node .\dist\cli.js gateway start" -ForegroundColor White
