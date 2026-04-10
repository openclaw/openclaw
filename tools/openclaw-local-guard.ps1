[CmdletBinding()]
param(
  [ValidateSet('status', 'repair', 'smoke')]
  [string]$Action = 'status',
  [string]$WslDistro = 'Ubuntu',
  [string]$WslUser = 'root',
  [string]$Model = 'gemma4:e4b',
  [int]$GatewayPort = 8081,
  [int]$OllamaPort = 11434,
  [int]$EdgeDebugPort = 9333,
  [int]$ProxyPort = 9334,
  [string]$JsonOut = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Wsl {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [switch]$AllowFailure
  )

  $output = & wsl -d $WslDistro -u $WslUser -- bash -lc "$Command" 2>&1
  $exitCode = $LASTEXITCODE
  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "WSL command failed ($exitCode): $Command`n$($output -join "`n")"
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = @($output)
  }
}

function Test-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSec = 4
  )

  try {
    $invokeParams = @{
      Uri = $Url
      TimeoutSec = $TimeoutSec
    }
    if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('UseBasicParsing')) {
      $invokeParams['UseBasicParsing'] = $true
    }
    $resp = Invoke-WebRequest @invokeParams
    return [pscustomobject]@{
      Ok     = $true
      Detail = "HTTP $([int]$resp.StatusCode)"
    }
  } catch {
    return [pscustomobject]@{
      Ok     = $false
      Detail = $_.Exception.Message
    }
  }
}

function Get-WslGatewayIp {
  $result = Invoke-Wsl -Command "ip route | sed -n 's/^default via \\([^ ]*\\).*/\\1/p' | head -n 1" -AllowFailure
  $ip = ($result.Output | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($ip) -or $ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    return $null
  }
  return $ip
}

function Get-EdgePath {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) {
      return $path
    }
  }
  return $null
}

function Ensure-EdgeDebugSession {
  $edgePath = Get-EdgePath
  if (-not $edgePath) {
    return [pscustomobject]@{ Ok = $false; Detail = 'Edge executable not found.' }
  }

  $existing = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'msedge.exe' -and
      $_.CommandLine -like "*--remote-debugging-port=$EdgeDebugPort*" -and
      $_.CommandLine -like '*openclaw-edge-cdp*'
    } |
    Select-Object -First 1

  if (-not $existing) {
    $userDataDir = 'C:\openclaw-edge-cdp'
    New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null
    Start-Process -FilePath $edgePath -ArgumentList @(
      "--remote-debugging-port=$EdgeDebugPort",
      '--remote-debugging-address=127.0.0.1',
      "--user-data-dir=$userDataDir"
    ) | Out-Null
    Start-Sleep -Seconds 2
  }

  return Test-HttpEndpoint -Url "http://127.0.0.1:$EdgeDebugPort/json/version"
}

function Ensure-CdpProxy {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    return [pscustomobject]@{ Ok = $false; Detail = 'node command not found.' }
  }

  $proxyScript = Join-Path $PSScriptRoot 'openclaw-cdp-proxy.js'
  if (-not (Test-Path $proxyScript)) {
    return [pscustomobject]@{ Ok = $false; Detail = "Proxy script not found: $proxyScript" }
  }

  $existing = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -like "*openclaw-cdp-proxy.js*" -and
      $_.CommandLine -like "*--listen-port $ProxyPort*" -and
      $_.CommandLine -like "*--target-port $EdgeDebugPort*"
    } |
    Select-Object -First 1

  if (-not $existing) {
    Start-Process -FilePath $nodeCmd.Source -ArgumentList @(
      $proxyScript,
      '--listen-port', $ProxyPort,
      '--target-port', $EdgeDebugPort
    ) -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 1
  }

  return Test-HttpEndpoint -Url "http://127.0.0.1:$ProxyPort/json/version"
}

function Ensure-WslCoreServices {
  $service = Invoke-Wsl -Command "systemctl is-active ollama || true" -AllowFailure
  $serviceState = ($service.Output | Select-Object -First 1).Trim()
  if ($serviceState -ne 'active') {
    [void](Invoke-Wsl -Command 'systemctl start ollama' -AllowFailure)
    Start-Sleep -Seconds 2
  }

  $running = Invoke-Wsl -Command "pgrep -af 'openclaw-gateway|ollama launch openclaw|openclaw launch' || true" -AllowFailure
  if (-not @($running.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count) {
    [void](Invoke-Wsl -Command "setsid ollama launch openclaw --yes --model $Model >/tmp/openclaw-launch.log 2>&1 < /dev/null &" -AllowFailure)
    Start-Sleep -Seconds 4
  }
}

function Get-OpenClawStatus {
  $checks = @()
  $gatewayIp = $null
  $configCdpUrl = ''

  try {
    $wslPing = Invoke-Wsl -Command 'echo ok'
    $checks += [pscustomobject]@{ name = 'wsl_reachable'; ok = ($wslPing.ExitCode -eq 0); detail = (($wslPing.Output | Select-Object -First 1).Trim()) }
  } catch {
    $checks += [pscustomobject]@{ name = 'wsl_reachable'; ok = $false; detail = $_.Exception.Message }
  }

  $gatewayIp = Get-WslGatewayIp
  $gatewayDetail = 'not resolved'
  if ($gatewayIp) {
    $gatewayDetail = $gatewayIp
  }
  $checks += [pscustomobject]@{
      name = 'wsl_gateway_ip'
      ok = -not [string]::IsNullOrWhiteSpace($gatewayIp)
      detail = $gatewayDetail
    }

  $ollamaPortCheck = Invoke-Wsl -Command "ss -ltn '( sport = :$OllamaPort )' | tail -n +2 | wc -l" -AllowFailure
  $ollamaListening = ((($ollamaPortCheck.Output | Select-Object -First 1).Trim()) -as [int]) -gt 0
  $checks += [pscustomobject]@{ name = 'ollama_listening'; ok = $ollamaListening; detail = "port $OllamaPort" }

  $gatewayPortCheck = Invoke-Wsl -Command "ss -ltn '( sport = :$GatewayPort )' | tail -n +2 | wc -l" -AllowFailure
  $gatewayListening = ((($gatewayPortCheck.Output | Select-Object -First 1).Trim()) -as [int]) -gt 0
  $checks += [pscustomobject]@{ name = 'openclaw_gateway_listening'; ok = $gatewayListening; detail = "port $GatewayPort" }

  $configRaw = Invoke-Wsl -Command 'cat /root/.openclaw/openclaw.json' -AllowFailure
  if ($configRaw.ExitCode -eq 0) {
    try {
      $cfg = ($configRaw.Output -join "`n") | ConvertFrom-Json
      $allow = @($cfg.plugins.allow)
      $hasBrowser = $allow -contains 'browser'
      $hasWebSearch = $allow -contains 'openclaw-web-search'
      $hasOllama = $allow -contains 'ollama'
      $checks += [pscustomobject]@{ name = 'plugin_browser_enabled'; ok = $hasBrowser; detail = 'plugins.allow contains browser' }
      $checks += [pscustomobject]@{ name = 'plugin_web_search_enabled'; ok = $hasWebSearch; detail = 'plugins.allow contains openclaw-web-search' }
      $checks += [pscustomobject]@{ name = 'plugin_ollama_enabled'; ok = $hasOllama; detail = 'plugins.allow contains ollama' }
      $configCdpUrl = [string]$cfg.browser.profiles.windows.cdpUrl
    } catch {
      $checks += [pscustomobject]@{ name = 'config_parse'; ok = $false; detail = $_.Exception.Message }
    }
  } else {
    $checks += [pscustomobject]@{ name = 'config_exists'; ok = $false; detail = '/root/.openclaw/openclaw.json unreadable' }
  }

  $edgeStatus = Test-HttpEndpoint -Url "http://127.0.0.1:$EdgeDebugPort/json/version"
  $checks += [pscustomobject]@{ name = 'edge_debug_ready'; ok = $edgeStatus.Ok; detail = $edgeStatus.Detail }

  $proxyStatus = Test-HttpEndpoint -Url "http://127.0.0.1:$ProxyPort/json/version"
  $checks += [pscustomobject]@{ name = 'cdp_proxy_ready'; ok = $proxyStatus.Ok; detail = $proxyStatus.Detail }

  if ($gatewayIp) {
    $wslCdp = Invoke-Wsl -Command "curl -fsS --max-time 4 http://${gatewayIp}:$ProxyPort/json/version >/dev/null 2>&1; echo `$?" -AllowFailure
    $ok = ((($wslCdp.Output | Select-Object -First 1).Trim()) -eq '0')
    $checks += [pscustomobject]@{
        name = 'wsl_to_windows_cdp'
        ok = $ok
        detail = "http://${gatewayIp}:$ProxyPort/json/version"
      }
  } else {
    $checks += [pscustomobject]@{ name = 'wsl_to_windows_cdp'; ok = $false; detail = 'gateway ip missing' }
  }

  $failedChecks = 0
  foreach ($check in $checks) {
    if (-not [bool]$check.ok) {
      $failedChecks++
    }
  }
  $overall = ($failedChecks -eq 0)

  return [pscustomobject]@{
    ok = $overall
    action = $Action
    timestamp = (Get-Date).ToString('s')
    model = $Model
    cdpUrlInConfig = $configCdpUrl
    checks = @($checks)
  }
}

function Run-Repair {
  Ensure-WslCoreServices
  [void](Ensure-EdgeDebugSession)
  [void](Ensure-CdpProxy)
}

function Run-Smoke {
  $gatewayIp = Get-WslGatewayIp
  $smoke = @()

  $ollamaApi = Invoke-Wsl -Command "curl -fsS --max-time 4 http://127.0.0.1:$OllamaPort/api/version >/dev/null 2>&1; echo `$?" -AllowFailure
  $smoke += [pscustomobject]@{
      name = 'ollama_api'
      ok = ((($ollamaApi.Output | Select-Object -First 1).Trim()) -eq '0')
      detail = "http://127.0.0.1:$OllamaPort/api/version"
    }

  $gatewayApi = Invoke-Wsl -Command "curl -fsS --max-time 4 http://127.0.0.1:$GatewayPort >/dev/null 2>&1; echo `$?" -AllowFailure
  $smoke += [pscustomobject]@{
      name = 'openclaw_gateway_api'
      ok = ((($gatewayApi.Output | Select-Object -First 1).Trim()) -eq '0')
      detail = "http://127.0.0.1:$GatewayPort"
    }

  if ($gatewayIp) {
    $cdp = Invoke-Wsl -Command "curl -fsS --max-time 4 http://${gatewayIp}:$ProxyPort/json/version >/dev/null 2>&1; echo `$?" -AllowFailure
    $smoke += [pscustomobject]@{
        name = 'wsl_to_cdp'
        ok = ((($cdp.Output | Select-Object -First 1).Trim()) -eq '0')
        detail = "http://${gatewayIp}:$ProxyPort/json/version"
      }
  } else {
    $smoke += [pscustomobject]@{
        name = 'wsl_to_cdp'
        ok = $false
        detail = 'gateway ip missing'
      }
  }

  return @($smoke)
}

if ($Action -eq 'repair' -or $Action -eq 'smoke') {
  Run-Repair
}

$status = Get-OpenClawStatus
if ($Action -eq 'smoke') {
  $status | Add-Member -NotePropertyName smoke -NotePropertyValue (Run-Smoke)
  $smokeFailed = 0
  foreach ($item in $status.smoke) {
    if (-not [bool]$item.ok) {
      $smokeFailed++
    }
  }
  $status.ok = ([bool]$status.ok -and ($smokeFailed -eq 0))
}

$json = $status | ConvertTo-Json -Depth 8

if (-not [string]::IsNullOrWhiteSpace($JsonOut)) {
  $parentDir = Split-Path -Parent $JsonOut
  if (-not [string]::IsNullOrWhiteSpace($parentDir) -and -not (Test-Path $parentDir)) {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
  }
  $json | Set-Content -Path $JsonOut -Encoding UTF8
}

$json
