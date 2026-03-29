/**
 * Core DeFi and arbitrage types for flashloan arbitrage
 */

export interface BlockchainConfig {
	rpcUrl: string
	chainId: number
	privateKey?: string
	gasLimit?: bigint
	maxGasPrice?: bigint
}

export interface AaveConfig {
	poolAddressProvider: string
	pool: string
	dataProvider: string
	weth: string
}

export interface DEXConfig {
	name: string
	router: string
	factory: string
	fee?: number
}

export interface ArbitrageOpportunity {
	tokenIn: string
	tokenOut: string
	amountIn: bigint
	expectedProfit: bigint
	path: string[]
	dexes: string[]
	gasEstimate: bigint
	timestamp: number
	profitAfterGas: bigint
}

export interface FlashloanParams {
	asset: string
	amount: bigint
	params: string
}

export interface ArbitrageConfig {
	minProfitThreshold: bigint
	maxGasPrice: bigint
	scanInterval: number
	dexes: DEXConfig[]
	aave: AaveConfig
	blockchain: BlockchainConfig
	enabled: boolean
}

export interface PriceData {
	dex: string
	tokenA: string
	tokenB: string
	price: bigint
	liquidity: bigint
	timestamp: number
}

export interface ArbitrageStats {
	totalOpportunities: number
	executedTrades: number
	successfulTrades: number
	failedTrades: number
	totalProfit: bigint
	totalLoss: bigint
	netProfit: bigint
	lastScanTime: number
	lastExecutionTime: number
}
