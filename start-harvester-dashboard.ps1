#!/usr/bin/env pwsh

param(
    [ValidateSet("all", "backend", "ui")]
    [string]$Mode = "all",

    [switch]$Stop
)

$repoRoot = $PSScriptRoot
$uiRoot = Join-Path $repoRoot "control-ui"
$stateDir = Join-Path $repoRoot ".artifacts"
$statePath = Join-Path $stateDir "harvester-dashboard-host.json"

$backendPort = 8081
$uiPort = 5174
$postgresPort = 5433
$postgresContainerName = "openclaw-harvester-pg"
$postgresVolumeName = "openclaw-harvester-pg-data"
$postgresImage = "postgres:16-alpine"
$postgresDatabase = "alpacoredb"
$postgresUser = "alpacoreadmin"
$postgresPassword = "alpacore-local-dev"

function Import-EnvFile([string]$path) {
    if (-not (Test-Path $path)) {
        return
    }

    foreach ($rawLine in Get-Content $path) {
        $trimmedLine = $rawLine.Trim()

        if (-not $trimmedLine -or $trimmedLine.StartsWith("#")) {
            continue
        }

        $normalizedLine = if ($trimmedLine.StartsWith("export ")) {
            $trimmedLine.Substring(7).Trim()
        }
        else {
            $trimmedLine
        }

        $separatorIndex = $normalizedLine.IndexOf("=")
        if ($separatorIndex -le 0) {
            continue
        }

        $key = $normalizedLine.Substring(0, $separatorIndex).Trim()
        $value = $normalizedLine.Substring($separatorIndex + 1).Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        Set-Item -Path ("Env:" + $key) -Value $value
    }
}

function Stop-TrackedProcess([int]$processId) {
    if ($processId -le 0) {
        return
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ManagedProcesses() {
    if (-not (Test-Path $statePath)) {
        return
    }

    try {
        $state = Get-Content $statePath -Raw | ConvertFrom-Json
        if ($state.backendPwshPid) {
            Stop-TrackedProcess -processId ([int]$state.backendPwshPid)
        }
        if ($state.uiPwshPid) {
            Stop-TrackedProcess -processId ([int]$state.uiPwshPid)
        }
    }
    catch {
    }

    Remove-Item $statePath -Force -ErrorAction SilentlyContinue
}

function Stop-PortListeners([int[]]$ports) {
    foreach ($port in $ports) {
        $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

        foreach ($processId in $listeners) {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            if ($processInfo -and $processInfo.Name -eq "node.exe") {
                Stop-TrackedProcess -processId ([int]$processId)
            }
        }
    }
}

function Start-DockerDesktopIfNeeded() {
    docker info --format '{{.ServerVersion}}' *> $null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "🐳 Starting Docker Desktop..." -ForegroundColor Cyan
    docker desktop start --timeout 300
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop failed to start"
    }
}

function Start-LocalPostgresContainer() {
    docker image inspect $postgresImage *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "📥 Pulling $postgresImage..." -ForegroundColor Cyan
        docker pull $postgresImage
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to pull $postgresImage"
        }
    }

    docker rm -f $postgresContainerName *> $null
    docker volume create $postgresVolumeName *> $null

    Write-Host "🗄️ Starting local PostgreSQL on localhost:$postgresPort..." -ForegroundColor Cyan
    $dockerArgs = @(
        "run",
        "-d",
        "--name",
        $postgresContainerName,
        "-e",
        "POSTGRES_DB=$postgresDatabase",
        "-e",
        "POSTGRES_USER=$postgresUser",
        "-e",
        "POSTGRES_PASSWORD=$postgresPassword",
        "-p",
        "${postgresPort}:5432",
        "-v",
        "${postgresVolumeName}:/var/lib/postgresql/data",
        $postgresImage
    )
    docker @dockerArgs *> $null

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to start local PostgreSQL container"
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        docker exec $postgresContainerName pg_isready -U $postgresUser -d $postgresDatabase *> $null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }

        Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
        throw "Local PostgreSQL did not become ready on port $postgresPort"
    }
}

function Get-GitHubToken() {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
        return $null
    }

    try {
        $token = gh auth token
        if ([string]::IsNullOrWhiteSpace($token)) {
            return $null
        }

        return $token.Trim()
    }
    catch {
        return $null
    }
}

function Start-BackendProcess() {
    $arguments = @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $PSCommandPath,
        "-Mode",
        "backend"
    )

    return Start-Process pwsh -WorkingDirectory $repoRoot -ArgumentList $arguments -PassThru
}

function Start-UiProcess() {
    $arguments = @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $PSCommandPath,
        "-Mode",
        "ui"
    )

    return Start-Process pwsh -WorkingDirectory $uiRoot -ArgumentList $arguments -PassThru
}

function Write-State([System.Diagnostics.Process]$backendProcess, [System.Diagnostics.Process]$uiProcess) {
    New-Item -ItemType Directory -Path $stateDir -Force *> $null

    $state = [pscustomobject]@{
        backendPwshPid        = $backendProcess.Id
        uiPwshPid             = $uiProcess.Id
        backendPort           = $backendPort
        uiPort                = $uiPort
        postgresPort          = $postgresPort
        postgresContainerName = $postgresContainerName
        updatedAt             = (Get-Date).ToString("o")
    }

    $state | ConvertTo-Json | Set-Content -Path $statePath
}

function Wait-ForHttp([string]$url, [int]$attempts = 30) {
    for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 *> $null
            return $true
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }

    return $false
}

if ($Stop) {
    Stop-ManagedProcesses
    Stop-PortListeners -ports @($backendPort, $uiPort)
    docker rm -f $postgresContainerName *> $null

    Write-Host "🛑 Stopped isolated harvester dashboard stack" -ForegroundColor Yellow
    exit 0
}

switch ($Mode) {
    "backend" {
        Set-Location $repoRoot
        Start-DockerDesktopIfNeeded
        Start-LocalPostgresContainer
        Import-EnvFile (Join-Path $repoRoot ".env")
        Import-EnvFile (Join-Path $repoRoot ".azure/dev/.env")

        if ($env:AZURE_KEY_VAULT_NAME -and -not $env:HARVESTER_KEY_VAULT_NAME) {
            $env:HARVESTER_KEY_VAULT_NAME = $env:AZURE_KEY_VAULT_NAME
        }

        # The env file currently carries a non-Stripe-shaped value in STRIPE_SECRET_KEY.
        # Prefer Key Vault resolution when a Key Vault name is available.
        if ($env:HARVESTER_KEY_VAULT_NAME) {
            Remove-Item Env:STRIPE_SECRET_KEY -ErrorAction SilentlyContinue
        }

        $githubToken = Get-GitHubToken
        if ($githubToken) {
            $env:HARVESTER_GITHUB_TOKEN = $githubToken
        }

        $env:DATABASE_HOST = "127.0.0.1"
        $env:DATABASE_PORT = "$postgresPort"
        $env:DATABASE_NAME = $postgresDatabase
        $env:DATABASE_USER = $postgresUser
        $env:DATABASE_PASSWORD = $postgresPassword
        $env:DATABASE_SSLMODE = "disable"
        $env:HARVESTER_PUBLIC_URL = "http://localhost:$backendPort"
        $env:HARVESTER_PORT = "$backendPort"
        $env:HOST = "0.0.0.0"

        node harvester-server.mjs
        exit $LASTEXITCODE
    }

    "ui" {
        Set-Location $uiRoot
        $env:VITE_API_URL = "http://localhost:$backendPort"
        npm run dev -- --port $uiPort
        exit $LASTEXITCODE
    }

    default {
        Set-Location $repoRoot
        Start-DockerDesktopIfNeeded
        Stop-ManagedProcesses
        Stop-PortListeners -ports @($backendPort, $uiPort)
        Start-LocalPostgresContainer

        Write-Host "🚀 Starting isolated harvester backend on http://localhost:$backendPort ..." -ForegroundColor Green
        $backendProcess = Start-BackendProcess

        Write-Host "🖥️ Starting isolated dashboard UI on http://localhost:$uiPort ..." -ForegroundColor Green
        $uiProcess = Start-UiProcess

        Write-State -backendProcess $backendProcess -uiProcess $uiProcess

        $backendReady = Wait-ForHttp -url "http://localhost:$backendPort/api/health" -attempts 60
        $uiReady = Wait-ForHttp -url "http://localhost:$uiPort/"

        Write-Host "" 
        Write-Host "✅ Isolated dashboard stack started" -ForegroundColor Green
        Write-Host "   UI:       http://localhost:$uiPort" -ForegroundColor Cyan
        Write-Host "   API:      http://localhost:$backendPort/api/health" -ForegroundColor Cyan
        Write-Host "   Logs WS:  ws://localhost:$backendPort/api/logs/stream" -ForegroundColor Cyan
        Write-Host "   Postgres: localhost:$postgresPort" -ForegroundColor Cyan
        Write-Host "   Backend ready: $backendReady" -ForegroundColor Yellow
        Write-Host "   UI ready:      $uiReady" -ForegroundColor Yellow
        Write-Host "" 
        Write-Host "🛑 To stop: .\start-harvester-dashboard.ps1 -Stop" -ForegroundColor Red
        exit 0
    }
}
