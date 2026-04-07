@echo off
setlocal enabledelayedexpansion
title KASAI - Open WebUI
color 0B
chcp 65001 >nul 2>&1

:: -----------------------------------------------------------
:: Setup log file alongside this bat
:: -----------------------------------------------------------
set LOGFILE=%~dp0openwebui-install.log
echo [%date% %time%] === Session Start === > "%LOGFILE%"

echo ============================================
echo   KASAI - Open WebUI Setup ^& Launch
echo ============================================
echo.
echo   Log: openwebui-install.log
echo.

:: -----------------------------------------------------------
:: CONFIG
:: -----------------------------------------------------------
set GATEWAY_URL=http://127.0.0.1:18789/v1
set GATEWAY_TOKEN=d8a30751781cf0d08537277149080d4ffdc57262d6a99aec
set WEBUI_PORT=3000
set UVX_EXE=C:\Users\MAG MSI\.local\bin\uvx.exe

:: -----------------------------------------------------------
:: 1. Verify uvx exists
:: -----------------------------------------------------------
echo [1/4] Checking uvx...
"%UVX_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: uvx not found at %UVX_EXE%
    echo   Install with: winget install astral-sh.uv
    echo [%time%] FAIL: uvx not found >> "%LOGFILE%"
    goto :fail
)
for /f "tokens=*" %%v in ('"%UVX_EXE%" --version 2^>^&1') do echo   %%v
echo.

:: -----------------------------------------------------------
:: 2. Wait for OpenClaw gateway
:: -----------------------------------------------------------
echo [2/4] Waiting for gateway at 127.0.0.1:18789...
echo   (Run start-openclaw.bat if not already running)

:gwait
curl -s -o nul http://127.0.0.1:18789 >nul 2>&1
if errorlevel 1 (
    echo   ...not ready, checking again in 10s
    timeout /t 10 /nobreak >nul
    goto gwait
)
echo   Gateway UP.
echo [%time%] Gateway confirmed >> "%LOGFILE%"
echo.

:: -----------------------------------------------------------
:: 3. Verify models endpoint
:: -----------------------------------------------------------
echo [3/4] Checking /v1/models...
curl -s -o nul -w "%%{http_code}" -H "Authorization: Bearer %GATEWAY_TOKEN%" http://127.0.0.1:18789/v1/models > "%TEMP%\owui-check.txt" 2>&1
set /p MSTATUS=<"%TEMP%\owui-check.txt"
if "%MSTATUS%"=="200" (
    echo   Models endpoint: 200 OK
) else (
    echo   WARNING: Got status %MSTATUS% from /v1/models
    echo   HTTP endpoint may not be enabled in openclaw.json
)
echo [%time%] Models check: %MSTATUS% >> "%LOGFILE%"
echo.

:: -----------------------------------------------------------
:: 4. Set env vars and launch
:: -----------------------------------------------------------
echo [4/4] Launching Open WebUI on port %WEBUI_PORT%...
echo.
echo ============================================
echo   URL:     http://localhost:%WEBUI_PORT%
echo   Backend: %GATEWAY_URL%
echo.
echo   First run caches ~500MB of packages.
echo   This window stays open. Ctrl+C to stop.
echo ============================================
echo.

:: Auto-open browser after 15s
start "" cmd /c "timeout /t 15 /nobreak >nul && start http://localhost:%WEBUI_PORT%" >nul 2>&1

:: -----------------------------------------------------------
:: Launch via uvx with Python 3.12
:: PYTHONIOENCODING=utf-8 fixes the Unicode banner crash on Windows cp1252
:: PYTHONUTF8=1 is the belt to that suspender
:: -----------------------------------------------------------
echo [%time%] Launching: uvx --python 3.12 open-webui serve >> "%LOGFILE%"

powershell -NoProfile -Command "& { $env:OPENAI_API_BASE_URL='%GATEWAY_URL%'; $env:OPENAI_API_KEY='%GATEWAY_TOKEN%'; $env:OPENAI_API_BASE_URLS='%GATEWAY_URL%'; $env:OPENAI_API_KEYS='%GATEWAY_TOKEN%'; $env:ENABLE_OLLAMA_API='false'; $env:WEBUI_AUTH='false'; $env:WEBUI_SECRET_KEY='kasai-openclaw-local'; $env:PORT='%WEBUI_PORT%'; $env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '%UVX_EXE%' --python 3.12 open-webui serve --port %WEBUI_PORT% 2>&1 | Tee-Object -FilePath '%LOGFILE%' -Append }"

if errorlevel 1 (
    echo.
    echo   Python 3.12 attempt failed. Retrying without version pin...
    echo [%time%] Retry without python pin >> "%LOGFILE%"
    
    powershell -NoProfile -Command "& { $env:OPENAI_API_BASE_URL='%GATEWAY_URL%'; $env:OPENAI_API_KEY='%GATEWAY_TOKEN%'; $env:OPENAI_API_BASE_URLS='%GATEWAY_URL%'; $env:OPENAI_API_KEYS='%GATEWAY_TOKEN%'; $env:ENABLE_OLLAMA_API='false'; $env:WEBUI_AUTH='false'; $env:WEBUI_SECRET_KEY='kasai-openclaw-local'; $env:PORT='%WEBUI_PORT%'; $env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '%UVX_EXE%' open-webui serve --port %WEBUI_PORT% 2>&1 | Tee-Object -FilePath '%LOGFILE%' -Append }"
    
    if errorlevel 1 (
        echo.
        echo   BOTH ATTEMPTS FAILED.
        goto :fail
    )
)

echo.
echo Open WebUI stopped.
goto :done

:fail
echo.
echo ============================================
echo   FAILED - see openwebui-install.log
echo ============================================
echo [%time%] SCRIPT FAILED >> "%LOGFILE%"
echo.
pause
exit /b 1

:done
echo [%time%] Clean exit >> "%LOGFILE%"
pause
exit /b 0
