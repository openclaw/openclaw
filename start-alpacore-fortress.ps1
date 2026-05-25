#!/usr/bin/env pwsh

param(
    [switch]$Stop,
    [switch]$WithTsgo
)

$ErrorActionPreference = "Stop"

$composeFile = Join-Path $PSScriptRoot "docker-compose.alpacore-fortress.yml"
$composeArgs = @("-p", "alpacore-fortress", "-f", $composeFile)
$postgresPort = if ($env:ALPACORE_FORTRESS_POSTGRES_PORT) { $env:ALPACORE_FORTRESS_POSTGRES_PORT } else { "55433" }
$env:ALPACORE_FORTRESS_POSTGRES_PORT = $postgresPort
$localEnvFile = Join-Path $PSScriptRoot ".env"
$revolutEnvNames = @(
    "AIRTABLE_API_BASE_URL",
    "AIRTABLE_API_TOKEN",
    "AIRTABLE_ENTERPRISE_KEY",
    "AIRTABLE_TRANSFER_BASE_ID",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TRANSFER_TABLE_ID_OR_NAME",
    "AIRTABLE_TABLE_ID_OR_NAME",
    "AIRTABLE_TRANSFER_VIEW",
    "AIRTABLE_TRANSFER_PAGE_SIZE",
    "AIRTABLE_TRANSFER_MAX_RECORDS",
    "REVOLUT_API_BASE_URL",
    "REVOLUT_API_SECRET",
    "REVOLUT_BASE_URL",
    "REVOLUT_CLIENT_ID",
    "REVOLUT_MERCHANT_API_BASE_URL",
    "REVOLUT_MERCHANT_API_KEY",
    "REVOLUT_MERCHANT_API_VERSION",
    "REVOLUT_MERCHANT_CREATE_ORDER_PATH",
    "REVOLUT_REFRESH_TOKEN",
    "REVOLUT_SIGNER_BASE_URL",
    "REVOLUT_SIGNER_PATH",
    "REVOLUT_SIGNER_SERVICE_TOKEN",
    "REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID",
    "REVOLUT_TRANSFER_COUNTERPARTY_ID",
    "REVOLUT_TRANSFER_RECEIVER_ACCOUNT_ID",
    "REVOLUT_TRANSFER_RECEIVER_CARD_ID",
    "REVOLUT_TRANSFER_CURRENCY",
    "REVOLUT_TRANSFER_REFERENCE_PREFIX",
    "REVOLUT_TRANSFER_REASON_CODE",
    "REVOLUT_TRANSFER_CHARGE_BEARER",
    "REVOLUT_TRANSFER_EXECUTION_ENABLED",
    "REVOLUT_TRANSFER_EXECUTION_BATCH_SIZE",
    "ALPHABET_PAYPAL_RECOVERY_PRINCIPAL_EUR",
    "ALPHABET_PAYPAL_RECOVERY_APR",
    "ALPHABET_PAYPAL_RECOVERY_TARGET_DATE",
    "PAYPAL_SANDBOX_CLIENT_ID",
    "PAYPAL_SANDBOX_CLIENT_SECRET",
    "PAYPAL_SANDBOX_WEBHOOK_ID",
    "PAYPAL_SANDBOX_API_BASE_URL"
)

function Import-AllowlistedEnvFile([string]$filePath, [string[]]$allowedNames) {
    if (-not (Test-Path $filePath)) {
        return
    }

    $allowedLookup = @{}
    foreach ($name in $allowedNames) {
        $allowedLookup[$name] = $true
    }

    foreach ($rawLine in Get-Content $filePath) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            continue
        }

        if ($line.StartsWith('export ')) {
            $line = $line.Substring(7).Trim()
        }

        $separatorIndex = $line.IndexOf('=')
        if ($separatorIndex -le 0) {
            continue
        }

        $name = $line.Substring(0, $separatorIndex).Trim()
        if (-not $allowedLookup.ContainsKey($name)) {
            continue
        }

        $value = $line.Substring($separatorIndex + 1).Trim()
        if (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        Set-Item -Path "Env:$name" -Value $value
    }
}

Import-AllowlistedEnvFile -filePath $localEnvFile -allowedNames $revolutEnvNames

function Wait-ForHttpOk([string]$url, [int]$attempts = 60, [int]$delayMilliseconds = 1000) {
    for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return $true
            }
        }
        catch {
        }

        Start-Sleep -Milliseconds $delayMilliseconds
    }

    return $false
}

if ($Stop) {
    docker compose @composeArgs down --remove-orphans
    Write-Host "🛑 Stopped AlpaCore fortress stack" -ForegroundColor Yellow
    exit 0
}

docker compose @composeArgs up -d --build alpacore-postgres alpacore arni-terminal
if ($LASTEXITCODE -ne 0) {
    throw "docker compose up failed with exit code $LASTEXITCODE"
}

if ($WithTsgo) {
    docker compose @composeArgs run --rm alpacore-tsgo
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose run alpacore-tsgo failed with exit code $LASTEXITCODE"
    }
}

$readyOk = Wait-ForHttpOk -url "http://127.0.0.1:5143/api/ready"
$pageOk = Wait-ForHttpOk -url "http://127.0.0.1:5143/arni_ceo_terminal.html"

Write-Host "" 
Write-Host "✅ AlpaCore fortress stack started" -ForegroundColor Green
Write-Host "   Terminal: http://127.0.0.1:5143/arni_ceo_terminal.html"
Write-Host "   Ready API: http://127.0.0.1:5143/api/ready"
Write-Host "   Postgres: 127.0.0.1:$postgresPort"
Write-Host "   Ready:    $readyOk"
Write-Host "   Page:     $pageOk"
