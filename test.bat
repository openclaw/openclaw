@echo off
powershell -NoProfile -Command "$cfgPath = Join-Path $env:USERPROFILE '.openclaw-dev\openclaw.json'; if (Test-Path $cfgPath) { $cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json); $cfg.gateway.auth.token }"
pause
